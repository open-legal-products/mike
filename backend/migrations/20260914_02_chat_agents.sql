-- Migration date: 2026-09-14
-- Highlight-assigned chat agents.
--
-- An "agent" is a real chat row parented to the chat whose assistant response
-- the user highlighted. Modelling it as a chat (rather than a bespoke table)
-- means the agent's thread gets the whole existing chat stack for free --
-- streaming, message persistence, access control, deletion cascade.
--
-- Four additive columns on `chats` carry the assignment:
--   parent_chat_id    the chat this agent was spawned from (null = ordinary
--                     chat). Depth is capped at one level in the API layer.
--   agent_instruction what the user asked this agent to do.
--   source_message_id the parent assistant message the excerpt came from.
--                     Deliberately not a foreign key: it is an anchor for
--                     rendering, and the parent-chat cascade below already
--                     removes agents when their conversation goes away.
--   source_excerpt    the highlighted text, stored so the dock and the
--                     proposal markers survive a reload.
--
-- `chat_messages.edited_at` records that an assistant message was rewritten by
-- an accepted agent proposal, so the UI can show a "revised" marker.

alter table public.chats
  add column if not exists parent_chat_id uuid
    references public.chats(id) on delete cascade,
  add column if not exists agent_instruction text,
  add column if not exists source_message_id uuid,
  add column if not exists source_excerpt text;

-- Partial: every lookup is "the agents of this parent", and ordinary chats
-- (the overwhelming majority of rows) never match.
create index if not exists idx_chats_parent
  on public.chats(parent_chat_id)
  where parent_chat_id is not null;

alter table public.chat_messages
  add column if not exists edited_at timestamptz;

-- Three read paths must stop counting agents as conversations. Each body below
-- is copied VERBATIM from backend/schema.sql on this branch, so a fresh install
-- and an upgraded deployment land on byte-identical definitions and the
-- "Fresh install vs upgraded deployment" drift gate stays green.
--
-- These bodies therefore carry everything main added since this feature was
-- first written -- the organization access columns, the access_role verdict
-- lateral, the visibility scopes -- with only the `parent_chat_id is null`
-- arms added on top. `create or replace` cannot change an existing function's
-- return type, so the argument and return lists must match what the previous
-- migration (20260904_01_organization_access.sql) left in place.
--
-- Agents are reached from their parent conversation, never from the global
-- recent-chats list.

create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into Owner standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner,
    -- The SAME verdict the predicate below filters on, served to the caller.
    -- Serving only is_owner was not enough: the client must distinguish
    -- Editor and Viewer from Owner so its actions match the server verdict.
    -- One evaluation, one truth: the lateral computes the role once and both
    -- the column and the WHERE read it.
    verdict.role as access_role
  from public.chats c
  left join public.projects p on p.id = c.project_id
  cross join lateral (
    select public.chat_access_role(
             c.id,
             c.user_id,
             c.project_id,
             c.org_id,
             p_user_id,
             p_user_email
           ) as role
  ) verdict
  -- The whole predicate, in one call.
  -- The join above is for project_name only; the function resolves the
  -- project itself.
  -- Agents (parent_chat_id set) are reached from their parent conversation,
  -- never from the global recent-chats list.
  where c.parent_chat_id is null
    and verdict.role is not null
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;


-- Both `get_projects_overview` overloads count a project's chats on the
-- project card. An agent inherits its parent's project binding for access
-- control, so without the same exclusion a conversation with three agents
-- would report itself as four chats.

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
      -- Agents belong to their parent conversation, not to the project's
      -- own chat list, so they must not inflate the project's chat count.
      and c.parent_chat_id is null
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    case
      when vp.org_id is not null then 'organization'
      when exists (
        select 1 from public.project_access_grants g
        where g.project_id = vp.id
      ) then 'shared'
      else 'private'
    end as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) is not null
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
        or (
          p_scope = 'collaborative'
          and (
            p.org_id is not null
            or p.user_id is null
            or p.user_id::text <> p_user_id
            or exists (
              select 1 from public.project_access_grants g
              where g.project_id = p.id
            )
          )
        )
        or (
          p_scope = 'private'
          and p.org_id is null
          and p.user_id::text = p_user_id
          and not exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id
          )
        )
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
      -- Agents belong to their parent conversation, not to the project's
      -- own chat list, so they must not inflate the project's chat count.
      and c.parent_chat_id is null
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    case
      when vp.org_id is not null then 'organization'
      when exists (
        select 1 from public.project_access_grants g
        where g.project_id = vp.id
      ) then 'shared'
      else 'private'
    end as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
