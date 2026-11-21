-- Migration date: 2026-10-29
--
-- GET /chat (get_chats_overview) decided visibility by calling
-- chat_access_role() for one row of public.chats after another, in activity
-- order, until a page was full. That call is opaque to the planner and runs
-- several lookups of its own, so a caller whose chats were older than other
-- tenants' paid one verdict for every newer chat on the installation
-- (MIKE-BACKEND-F: statement_timeout, SQLSTATE 57014; in the browser
-- MIKE-FRONTEND-C), and a member listing a busy organization without a limit
-- paid one for every chat in it.
--
-- This version evaluates the same ladder as chat_access_role,
-- project_access_role, standalone_org_access_role and org_private_access_role
-- with set-based joins. The planner reaches the caller's chats through
-- indexes (creator, reachable project, direct grant, opened private content)
-- and evaluates nothing it cannot return. The per-row functions remain the
-- authority for opening one chat (lib/access.ts, ensureChatAccess);
-- backend/src/modules/chat/__tests__/chat.overview.sql proves row-for-row
-- parity between the two for every access branch and runs in CI
-- (.github/workflows/schema-drift.yml). Change the ladder in both places.
--
-- Local PostgreSQL 17, 100k chats, 50k of them in one 200-member team:
--   caller whose chats are all older than the rest, first page   53 ms ->  1.6 ms
--   member of that team, first page                               18 ms ->   46 ms
--   member of that team, unbounded list (30k rows)              4140 ms ->   56 ms
-- The member's page is bounded by the 30k chats they can reach, no longer by
-- the whole table; the previous plan's cost grew with everyone else's traffic.
--
-- Safe to re-run: create or replace, same signature.

create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  updated_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language sql
stable
set search_path = public
as $$
-- Who is asking. The API passes the account id as text and the ladder only
-- ever compares it as text, so a value that is not a uuid matches no creator;
-- grants are stored lowercased.
with actor as materialized (
  select
    case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then p_user_id::uuid end as id,
    case when coalesce(p_user_email, '') <> '' then lower(p_user_email) end as email
),
-- The caller's organizations, plus the one derived fact the private-content
-- fallback needs (can_access_org_private_content, inlined).
membership as materialized (
  select m.org_id, m.role,
         (o.kind = 'team' and o.deleted_at is null
          and (m.role = 'owner' or (m.role = 'admin' and m.can_access_private_content))) as opens_private
  from public.org_members m
  join public.organizations o on o.id = m.org_id
  where m.user_id = (select id from actor)
),
-- Projects worth a verdict. Each indexed lookup is a superset of one branch
-- of project_access_role, so no reachable project is missed; the verdict
-- below removes the rest.
project_candidates as materialized (
  select p.id from public.projects p where p.user_id = (select id from actor)
  union
  select p.id from public.projects p join membership m on m.org_id = p.org_id
  union
  select g.project_id from public.project_access_grants g where g.email = (select email from actor)
  union
  select x.item_id from public.org_private_content_access x
    where x.user_id = (select id from actor) and x.kind = 'project'
),
-- project_access_role, set-based: the same branches in the same order, one
-- row per candidate. The coalesce is its org_private_access_role fallback
-- (a private project the caller opened as an owner or permitted admin).
reachable_projects as materialized (
  select p.id, p.name,
    coalesce(
      case
        when p.org_id is not null and (o.id is null or o.deleted_at is not null) then null
        when p.archived_at is not null then null
        when p.org_id is not null then
          case
            when m.org_id is null then null
            when p.user_id = (select id from actor) then 'owner'
            when m.role = 'owner' and (p.visibility = 'organization'
                 or public.project_is_ownerless(p.id, p.user_id, p.org_id)) then 'owner'
            when ov.role = 'deny' then null
            when ov.role in ('owner', 'editor', 'viewer') then ov.role
            when p.visibility = 'organization' then 'editor'
          end
        when p.user_id = (select id from actor) then 'owner'
        else g.role
      end,
      case when x.item_id is not null and m.opens_private
                and p.archived_at is null and p.visibility = 'private' then 'viewer' end
    ) as role
  from project_candidates c
  join public.projects p on p.id = c.id
  left join public.organizations o on o.id = p.org_id
  left join membership m on m.org_id = p.org_id
  left join public.project_org_access_overrides ov
    on ov.project_id = p.id and ov.org_id = p.org_id and ov.user_id = (select id from actor)
  left join public.project_access_grants g on g.project_id = p.id and g.email = (select email from actor)
  left join public.org_private_content_access x
    on x.org_id = p.org_id and x.user_id = (select id from actor) and x.kind = 'project' and x.item_id = p.id
),
-- Direct chat grants and opened private chats for the caller; both tiny.
granted_chats as materialized (
  select g.chat_id, g.role from public.chat_access_grants g where g.email = (select email from actor)
),
opened_chats as materialized (
  select x.org_id, x.item_id from public.org_private_content_access x
  where x.user_id = (select id from actor) and x.kind = 'chat'
)
-- chat_access_role, set-based, evaluated only for rows the candidate predicate
-- admits. Branch order mirrors the function; the coalesce is its
-- org_private_access_role fallback (an opened private standalone chat).
select c.id, c.project_id, c.user_id::text as user_id, c.title, c.model, c.created_at, c.updated_at,
       rp.name as project_name,
       coalesce(c.user_id = (select id from actor), false) as is_owner,
       verdict.role as access_role
from public.chats c
left join reachable_projects rp on rp.id = c.project_id
left join granted_chats g on g.chat_id = c.id
left join opened_chats x on x.item_id = c.id and x.org_id = c.org_id
left join membership m on m.org_id = c.org_id
left join public.organizations o on o.id = c.org_id
cross join lateral (
  select coalesce(
    case
      when c.org_id is not null and (o.id is null or o.deleted_at is not null) then null
      when c.project_id is not null then rp.role
      when o.kind = 'team' then
        case when m.org_id is null then null
             when c.user_id = (select id from actor) then 'owner'
             else g.role end
      when c.user_id = (select id from actor) then 'owner'
      else g.role
    end,
    case when x.item_id is not null and m.opens_private and c.project_id is null then 'viewer' end
  ) as role
) verdict
where c.archived_at is null
  and public.workspace_matches(p_workspace, c.org_id)
  and (
    p_before_updated_at is null
    or c.updated_at < p_before_updated_at
    or (c.updated_at = p_before_updated_at and c.id > p_before_id)
  )
  -- Candidates: four indexable facts. The scalar subqueries become InitPlans,
  -- so the planner can BitmapOr idx_chats_user, idx_chats_project and the
  -- primary key instead of walking chats in activity order.
  and (c.user_id = (select id from actor)
    or c.project_id = any (array(select id from reachable_projects where role is not null))
    or c.id = any (array(select chat_id from granted_chats))
    or c.id = any (array(select item_id from opened_chats)))
  and verdict.role is not null
order by c.updated_at desc, c.id asc
limit case when p_limit is null then null else greatest(1, least(p_limit, 100)) end
offset greatest(coalesce(p_offset, 0), 0);
$$;
