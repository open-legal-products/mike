-- Migration date: 2026-10-11
--
-- Add an organization Owner role above Admin.
--
-- Organizations had two roles and admins were peers: any admin could delete
-- the organization and appoint or remove any other admin. That leaves nowhere
-- to put the powers that can end an organization or decide who controls it
-- (deletion, appointing admins, and later billing and sign-in policy) apart
-- from the day-to-day work of inviting and removing people.
--
-- An owner tier existed before and was removed because only one person could
-- hold it, which made every organization a single point of failure. This one
-- may be held by several people; the guard below keeps at least one.
--
--   owner  - everything an admin can do, plus deleting the organization and
--            appointing or removing admins and other owners.
--   admin  - invites and removes members, manages invitations and settings.
--   member - collaborates.
--
-- Content access is unchanged by this migration: owners and admins both
-- inherit Owner on organization content and cannot be overridden or denied,
-- exactly as admins could not before.
--
-- Safe to re-run: constraints are dropped before they are added, functions
-- use create or replace, triggers are dropped before they are created, and
-- the backfill only touches organizations that have no owner yet.

-- ---------------------------------------------------------------------------
-- 1. Allow the role. Invitations stay admin/member: ownership is granted to
--    someone who has already joined, never offered to an address.
-- ---------------------------------------------------------------------------
alter table public.org_members
  drop constraint if exists org_members_role_check;
alter table public.org_members
  add constraint org_members_role_check
  check (role in ('owner', 'admin', 'member'));

-- ---------------------------------------------------------------------------
-- 2. "An organization must keep at least one owner", replacing the last-admin
--    guard. Installed BEFORE the backfill: the old guard would refuse to move
--    a sole admin off 'admin', which is exactly what the backfill does.
--
--    The shape is the old guard's: lock the organizations row to serialize
--    concurrent departures, and stand aside for the two legitimate cascades
--    (the organization itself, or the member's auth user, being deleted).
-- ---------------------------------------------------------------------------
create or replace function public.org_members_protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;

  -- Serialize concurrent owner departures on this org. If the org row is
  -- already deleted in this transaction (delete cascade), stand aside.
  perform 1 from public.organizations where id = old.org_id for update;
  if not found then
    return coalesce(new, old);
  end if;

  -- Member's auth user being deleted (cascade from auth.users): stand aside.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;

  if not exists (
    select 1 from public.org_members
    where org_id = old.org_id and role = 'owner' and user_id <> old.user_id
  ) then
    raise exception 'An organization must keep at least one owner'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists org_members_last_admin_guard on public.org_members;
drop trigger if exists org_members_last_owner_guard on public.org_members;
create trigger org_members_last_owner_guard
  before delete or update of role on public.org_members
  for each row execute procedure public.org_members_protect_last_owner();

drop function if exists public.org_members_protect_last_admin();

-- ---------------------------------------------------------------------------
-- 3. Backfill. Every existing admin becomes an owner.
--
--    Until now an admin could delete the organization and appoint or remove
--    any admin, and those are the owner powers. Promoting every admin keeps
--    each person's authority exactly where it was; picking one (the creator,
--    the earliest) would silently demote the rest.
--
--    Guarded by "this organization has no owner yet" so a second run cannot
--    promote admins that an owner has since appointed deliberately. The
--    subquery reads the statement's snapshot, so every admin of an ownerless
--    organization is promoted together.
-- ---------------------------------------------------------------------------
update public.org_members m
set role = 'owner',
    updated_at = now()
where m.role = 'admin'
  and not exists (
    select 1 from public.org_members existing_owner
    where existing_owner.org_id = m.org_id
      and existing_owner.role = 'owner'
  );

-- ---------------------------------------------------------------------------
-- 4. Content access: an owner inherits Owner exactly as an admin does.
-- ---------------------------------------------------------------------------
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
        when m.role in ('owner', 'admin') then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else 'editor'
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
        when m.role in ('owner', 'admin') then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else 'editor'
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

-- ---------------------------------------------------------------------------
-- 5. Overrides cannot target an owner or an admin: their Owner access is
--    implicit and immutable.
-- ---------------------------------------------------------------------------
create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare member_role text;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id into resource_org_id, resource_creator_id
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id into resource_org_id, resource_creator_id
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
  if member_role in ('owner', 'admin') then
    raise exception 'Organization owners and admins always have owner access'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Remove any former member override when someone is promoted, so management
-- UIs never present an implicit Owner as an editable assignment.
create or replace function public.cleanup_org_admin_access_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role in ('owner', 'admin') then
    delete from public.project_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;
