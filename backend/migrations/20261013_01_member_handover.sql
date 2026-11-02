-- Migration date: 2026-10-13
--
-- What happens to a member's work when they leave an organization.
--
-- Projects and workflows are the organization's lasting work, so somebody
-- must own them. Those the departing member alone owns are handed to a
-- member of the organization, chosen by the person leaving or by the admin
-- removing them (assign_org_member_items; the backend refuses the removal
-- until a successor is named).
--
-- Standalone chats and tabular reviews are private to their author. They are
-- not handed to anybody: they are deleted with the membership, unless
-- another member already holds an Owner grant on them. The organization's
-- owners no longer take them over.
--
--   org_member_sole_owned_items()    the projects and workflows to hand over
--   assign_org_member_items()        hand them to one member, as Owner
--   org_member_private_standalone()  the chats and reviews that go
--
-- Safe to re-run: create or replace, drop function if exists.

-- The private projects and workflows `p_user_id` is the only Owner of in
-- `p_org_id`: they created it or were made its Owner, and no other member is
-- one. A public item is left out: the organization's owners own those.
create or replace function public.org_member_sole_owned_items(
  p_org_id uuid,
  p_user_id uuid
)
returns table (kind text, item_id uuid, title text)
language sql
stable
set search_path = public
as $$
  select 'project'::text, p.id, p.name
  from public.projects p
  where p.org_id = p_org_id
    and p.visibility is distinct from 'organization'
    and (
      p.user_id = p_user_id
      or exists (
        select 1 from public.project_org_access_overrides held
        where held.project_id = p.id
          and held.user_id = p_user_id
          and held.role = 'owner'
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id
        and creator.user_id = p.user_id
        and creator.user_id <> p_user_id
    )
    and not exists (
      select 1 from public.project_org_access_overrides other
      where other.project_id = p.id
        and other.role = 'owner'
        and other.user_id <> p_user_id
    )
  union all
  select 'workflow'::text, w.id, w.title
  from public.workflows w
  where w.org_id = p_org_id
    and w.visibility is distinct from 'organization'
    and (
      w.user_id = p_user_id
      or exists (
        select 1 from public.workflow_org_access_overrides held
        where held.workflow_id = w.id
          and held.user_id = p_user_id
          and held.role = 'owner'
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id
        and creator.user_id = w.user_id
        and creator.user_id <> p_user_id
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides other
      where other.workflow_id = w.id
        and other.role = 'owner'
        and other.user_id <> p_user_id
    );
$$;

-- Make `p_to_user_id` the Owner of everything `p_from_user_id` alone owns in
-- the organization, and say how many items that was. The successor must be
-- another member; the override tables' own guard checks the rest.
create or replace function public.assign_org_member_items(
  p_org_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_assigned_by uuid
)
returns integer
language plpgsql
set search_path = public
as $$
declare item record;
declare assigned integer := 0;
begin
  if p_to_user_id is null or p_to_user_id = p_from_user_id then
    raise exception 'Work is handed to another member of the organization'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = p_to_user_id
  ) then
    raise exception 'Work is handed to another member of the organization'
      using errcode = '23514';
  end if;

  for item in
    select * from public.org_member_sole_owned_items(p_org_id, p_from_user_id)
  loop
    if item.kind = 'project' then
      insert into public.project_org_access_overrides
        (project_id, org_id, user_id, role, assigned_by)
      values (item.item_id, p_org_id, p_to_user_id, 'owner', p_assigned_by)
      on conflict (project_id, user_id) do update
        set role = 'owner',
            assigned_by = excluded.assigned_by,
            updated_at = now();
    else
      insert into public.workflow_org_access_overrides
        (workflow_id, org_id, user_id, role, assigned_by)
      values (item.item_id, p_org_id, p_to_user_id, 'owner', p_assigned_by)
      on conflict (workflow_id, user_id) do update
        set role = 'owner',
            assigned_by = excluded.assigned_by,
            updated_at = now();
    end if;
    assigned := assigned + 1;
  end loop;
  return assigned;
end;
$$;

-- The standalone chats and tabular reviews of `p_user_id` in `p_org_id` that
-- nobody else owns: the ones that go when they leave. One that another
-- member holds an Owner grant on stays, with that member.
create or replace function public.org_member_private_standalone(
  p_org_id uuid,
  p_user_id uuid
)
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public
as $$
  select 'chat'::text, c.id
  from public.chats c
  where c.org_id = p_org_id
    and c.project_id is null
    and c.user_id = p_user_id
    and not exists (
      select 1
      from public.chat_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.chat_id = c.id
        and g.role = 'owner'
        and holder.user_id <> p_user_id
    )
  union all
  select 'tabular_review'::text, r.id
  from public.tabular_reviews r
  where r.org_id = p_org_id
    and r.project_id is null
    and r.user_id = p_user_id
    and not exists (
      select 1
      from public.tabular_review_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.tabular_review_id = r.id
        and g.role = 'owner'
        and holder.user_id <> p_user_id
    );
$$;

-- A standalone chat or review in a team organization is its author's, and
-- whoever in the organization it was shared with. Nobody takes it over: when
-- its author leaves it is deleted (below), so the organization's owners have
-- no arm here.
create or replace function public.standalone_org_access_role(
  p_org_id uuid,
  p_creator_id uuid,
  p_user_id text,
  p_grant_role text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when not exists (
      select 1 from public.org_members m
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    ) then null
    when p_creator_id::text = p_user_id then 'owner'
    else p_grant_role
  end;
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

-- The five-argument form carried the take-over arm.
drop function if exists public.standalone_org_access_role(uuid, uuid, text, text, boolean);

-- A member who leaves takes nothing with them and leaves nothing private
-- behind: their per-item roles and grants go with their membership, and so
-- do the standalone chats and reviews nobody else owns. Done here, with the
-- membership row, so every way of leaving does it — being removed, leaving,
-- or the account being deleted.
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
  -- Team organizations only, and only while the organization itself is
  -- staying: when it is being deleted its content has already been dealt
  -- with, and its row is gone by the time this runs.
  if public.org_is_team(old.org_id) then
    delete from public.chats c
    using public.org_member_private_standalone(old.org_id, old.user_id) gone
    where gone.kind = 'chat' and c.id = gone.item_id;
    delete from public.tabular_reviews r
    using public.org_member_private_standalone(old.org_id, old.user_id) gone
    where gone.kind = 'tabular_review' and r.id = gone.item_id;
  end if;
  return old;
end;
$$;

revoke all on function public.org_member_sole_owned_items(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.assign_org_member_items(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.org_member_private_standalone(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.standalone_org_access_role(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.org_member_sole_owned_items(uuid, uuid)
  to service_role;
grant execute on function public.assign_org_member_items(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.org_member_private_standalone(uuid, uuid)
  to service_role;
grant execute on function public.standalone_org_access_role(uuid, uuid, text, text)
  to service_role;
