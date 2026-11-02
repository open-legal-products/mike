-- Migration date: 2026-10-12
--
-- An organization's owners no longer own its members' private work.
--
-- Until now an organization owner was an Owner of every project and workflow
-- in the organization, private ones included: they were listed all of them,
-- could open them, and could read the chats inside. Private is meant to be
-- private. An organization owner now has:
--
--   a public item                     Owner, as before
--   a private item                    nothing, unless they made it or it was
--                                     shared with them like any other member
--   a private item with no Owner left Owner: its creator has left the
--                                     organization (or their account is gone)
--                                     and nobody else was made an Owner
--
-- The last rule replaces the guard that refused to remove a member who alone
-- owned something. That guard only ever worked because owners owned
-- everything; without that it would make it impossible to remove somebody
-- who has already left the firm. Instead a departure is never blocked, and
-- what the member alone owned passes to the organization's owners.
--
-- Safe to re-run: create or replace throughout, drop if exists for the guard.

create or replace function public.project_is_ownerless(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_org_id is not null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = p_project_user_id
    )
    and not exists (
      select 1 from public.project_org_access_overrides o
      where o.project_id = p_project_id and o.role = 'owner'
    );
$$;

create or replace function public.workflow_is_ownerless(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
  p_org_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_org_id is not null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = p_workflow_user_id
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides o
      where o.workflow_id = p_workflow_id and o.role = 'owner'
    );
$$;

-- The same question for the backend, which holds an id rather than a row.
create or replace function public.org_item_is_ownerless(
  p_kind text,
  p_item_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select case p_kind
    when 'project' then coalesce((
      select public.project_is_ownerless(p.id, p.user_id, p.org_id)
      from public.projects p where p.id = p_item_id
    ), false)
    when 'workflow' then coalesce((
      select public.workflow_is_ownerless(w.id, w.user_id, w.org_id)
      from public.workflows w where w.id = p_item_id
    ), false)
    else false
  end;
$$;

-- Every private item without an Owner in the given organizations, for the
-- backend's list filters. Normally empty or close to it.
create or replace function public.ownerless_org_item_ids(p_org_ids uuid[])
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public
as $$
  select 'project'::text, p.id
  from public.projects p
  where p.org_id = any(p_org_ids)
    and p.visibility <> 'organization'
    and public.project_is_ownerless(p.id, p.user_id, p.org_id)
  union all
  select 'workflow'::text, w.id
  from public.workflows w
  where w.org_id = any(p_org_ids)
    and w.visibility <> 'organization'
    and public.workflow_is_ownerless(w.id, w.user_id, w.org_id);
$$;

create or replace function public.project_access_role(
  p_project_id uuid,
  p_project_user_id uuid,
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
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        -- An organization owner owns what is public, and what has no Owner
        -- left. A private item with an Owner is not theirs unless shared.
        when m.role = 'owner' and (
          (
            select project.visibility from public.projects project
            where project.id = p_project_id
          ) = 'organization'
          or public.project_is_ownerless(
            p_project_id, p_project_user_id, p_org_id
          )
        ) then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select project.visibility from public.projects project
          where project.id = p_project_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.workflow_access_role(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
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
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        -- As for projects: public, or left without an Owner.
        when m.role = 'owner' and (
          (
            select workflow.visibility from public.workflows workflow
            where workflow.id = p_workflow_id
          ) = 'organization'
          or public.workflow_is_ownerless(
            p_workflow_id, p_workflow_user_id, p_org_id
          )
        ) then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select workflow.visibility from public.workflows workflow
          where workflow.id = p_workflow_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      -- BOTH sides lowered. get_workflows_overview lists a share with
      -- lower() on both, so a legacy mixed-case row listed for its recipient
      -- and then 404'd the moment they opened it (and re-sharing produced a
      -- second row rather than updating the first). The 02 migration
      -- normalizes the stored values and adds a lowercase CHECK; this stays
      -- symmetrical with the overview regardless.
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and lower(s.shared_with_email) = lower(p_user_email)
      limit 1
    )
  end;
$$;

-- An organization owner may now be given a role on a private item, like any
-- other member. On a public item they are an Owner already.
create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare resource_visibility text;
declare member_role text;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id, p.visibility
        into resource_org_id, resource_creator_id, resource_visibility
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id, w.visibility
        into resource_org_id, resource_creator_id, resource_visibility
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  select m.role into member_role
  from public.org_members m
  where m.org_id = new.org_id and m.user_id = new.user_id
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  -- An organization owner owns every public item, so there is nothing to
  -- give or deny them there. A private item is not theirs unless shared, so
  -- there they are given a role like any other member.
  if member_role = 'owner' and resource_visibility = 'organization' then
    raise exception 'Organization owners always own a public item'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- A promotion to owner clears the new owner's overrides on public items only.
create or replace function public.cleanup_org_admin_access_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'owner' then
    delete from public.project_org_access_overrides o
    using public.projects p
    where o.org_id = new.org_id and o.user_id = new.user_id
      and p.id = o.project_id and p.visibility = 'organization';
    delete from public.workflow_org_access_overrides o
    using public.workflows w
    where o.org_id = new.org_id and o.user_id = new.user_id
      and w.id = o.workflow_id and w.visibility = 'organization';
  end if;
  return new;
end;
$$;

drop trigger if exists org_members_resource_owner_guard on public.org_members;
drop function if exists public.org_member_protect_resource_ownership();

revoke all on function public.project_is_ownerless(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.workflow_is_ownerless(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.org_item_is_ownerless(text, uuid)
  from public, anon, authenticated;
revoke all on function public.ownerless_org_item_ids(uuid[])
  from public, anon, authenticated;
grant execute on function public.project_is_ownerless(uuid, uuid, uuid)
  to service_role;
grant execute on function public.workflow_is_ownerless(uuid, uuid, uuid)
  to service_role;
grant execute on function public.org_item_is_ownerless(text, uuid)
  to service_role;
grant execute on function public.ownerless_org_item_ids(uuid[])
  to service_role;
