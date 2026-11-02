-- Migration date: 2026-10-12
--
-- Standalone chats and tabular reviews belong to a workspace (stage 2 of
-- making an organization mandatory).
--
-- A chat or review could carry an organization only by sitting in one of its
-- projects; started on its own, it was personal, wherever its author was
-- working. One started on its own in an organization's workspace now belongs
-- to that organization, and runs on its keys and models.
--
-- It is private to its author. The rule for a standalone chat or review in a
-- team organization (standalone_org_access_role):
--
--   * only current members of the organization can reach it at all, its
--     author included: it is the organization's, and stays when they leave;
--   * its author is its Owner;
--   * it can be shared with other members by email, at a role, as before; a
--     grant held by somebody outside the organization counts for nothing;
--   * when its author has left and no member holds an Owner grant on it, the
--     organization's owners take it over, as they do a private project.
--
-- Nothing changes for personal chats and reviews, or for ones in a project.
--
-- Safe to re-run: drop constraint if exists, create or replace.

alter table public.chats
  drop constraint if exists chats_org_requires_project;
alter table public.tabular_reviews
  drop constraint if exists tabular_reviews_org_requires_project;

-- Whether an id names a team organization. False for null and for a personal
-- organization: those are a person's own, and follow the personal rules.
create or replace function public.org_is_team(p_org_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org_id and o.kind = 'team'
  );
$$;

-- The role `p_user_id` holds on a standalone chat or review that belongs to
-- a team organization. `p_grant_role` is the caller's direct grant on it, if
-- any; `p_has_member_owner` whether a current member holds an Owner grant.
create or replace function public.standalone_org_access_role(
  p_org_id uuid,
  p_creator_id uuid,
  p_user_id text,
  p_grant_role text,
  p_has_member_owner boolean
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when caller.role is null then null
    when p_creator_id::text = p_user_id then 'owner'
    when p_grant_role is not null then p_grant_role
    when caller.role = 'owner'
      and not coalesce(p_has_member_owner, false)
      and not exists (
        select 1 from public.org_members creator
        where creator.org_id = p_org_id and creator.user_id = p_creator_id
      ) then 'owner'
    else null
  end
  from (
    select (
      select m.role from public.org_members m
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    ) as role
  ) caller;
$$;

create or replace function public.chat_access_role(
  p_chat_id uuid,
  p_chat_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when public.org_is_team(p_org_id) then public.standalone_org_access_role(
      p_org_id,
      p_chat_user_id,
      p_user_id,
      (
        select g.role from public.chat_access_grants g
        where g.chat_id = p_chat_id
          and coalesce(p_user_email, '') <> ''
          and g.email = lower(p_user_email)
        limit 1
      ),
      exists (
        select 1
        from public.chat_access_grants g
        join public.user_profiles holder on lower(holder.email) = g.email
        join public.org_members m
          on m.user_id = holder.user_id and m.org_id = p_org_id
        where g.chat_id = p_chat_id and g.role = 'owner'
      )
    )
    when p_chat_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.chat_access_grants g
      where g.chat_id = p_chat_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.review_access_role(
  p_review_id uuid,
  p_review_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when public.org_is_team(p_org_id) then public.standalone_org_access_role(
      p_org_id,
      p_review_user_id,
      p_user_id,
      (
        select g.role from public.tabular_review_access_grants g
        where g.tabular_review_id = p_review_id
          and coalesce(p_user_email, '') <> ''
          and g.email = lower(p_user_email)
        limit 1
      ),
      exists (
        select 1
        from public.tabular_review_access_grants g
        join public.user_profiles holder on lower(holder.email) = g.email
        join public.org_members m
          on m.user_id = holder.user_id and m.org_id = p_org_id
        where g.tabular_review_id = p_review_id and g.role = 'owner'
      )
    )
    when p_review_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.tabular_review_access_grants g
      where g.tabular_review_id = p_review_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

-- A member who leaves takes nothing with them: the grants they held on the
-- organization's standalone chats and reviews go with their membership, so
-- rejoining later does not quietly restore what they could open before.
create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from public.project_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.workflow_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.chat_access_grants g
  using public.chats c, public.user_profiles holder
  where g.chat_id = c.id
    and c.org_id = old.org_id
    and c.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  delete from public.tabular_review_access_grants g
  using public.tabular_reviews r, public.user_profiles holder
  where g.tabular_review_id = r.id
    and r.org_id = old.org_id
    and r.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  return old;
end;
$$;

revoke all on function public.org_is_team(uuid)
  from public, anon, authenticated;
revoke all on function public.standalone_org_access_role(uuid, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.org_is_team(uuid) to service_role;
grant execute on function public.standalone_org_access_role(uuid, uuid, text, text, boolean)
  to service_role;
