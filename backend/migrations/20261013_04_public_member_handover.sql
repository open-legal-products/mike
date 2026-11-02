-- Migration date: 2026-10-13
-- Public projects and workflows get a successor when their last explicitly
-- assigned owner leaves. Private items with no remaining owner are deleted.
-- Organization-wide ownership keeps public work accessible, but is not a
-- substitute for naming a successor. Personal workspaces are unaffected.
-- No private titles leave the database in the departure preview.

create or replace function public.org_members_departure_items(
  p_org_id uuid,
  p_user_ids uuid[]
)
returns table (kind text, item_id uuid, title text, disposition text)
language sql
stable
set search_path = public
as $$
  select 'project'::text, item.id,
    case when item.visibility = 'organization' then item.name else null end,
    case when item.visibility = 'organization' then 'transfer' else 'delete' end
  from public.projects item
  where item.org_id = p_org_id
    and (
      item.user_id = any(p_user_ids)
      or exists (
        select 1 from public.project_org_access_overrides held
        where held.project_id = item.id and held.role = 'owner'
          and held.user_id = any(p_user_ids)
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = item.user_id
        and not (creator.user_id = any(p_user_ids))
    )
    and not exists (
      select 1 from public.project_org_access_overrides other
      join public.org_members holder
        on holder.org_id = p_org_id and holder.user_id = other.user_id
      where other.project_id = item.id and other.role = 'owner'
        and not (other.user_id = any(p_user_ids))
    )
  union all
  select 'workflow'::text, item.id,
    case when item.visibility = 'organization' then item.title else null end,
    case when item.visibility = 'organization' then 'transfer' else 'delete' end
  from public.workflows item
  where item.org_id = p_org_id
    and (
      item.user_id = any(p_user_ids)
      or exists (
        select 1 from public.workflow_org_access_overrides held
        where held.workflow_id = item.id and held.role = 'owner'
          and held.user_id = any(p_user_ids)
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = item.user_id
        and not (creator.user_id = any(p_user_ids))
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides other
      join public.org_members holder
        on holder.org_id = p_org_id and holder.user_id = other.user_id
      where other.workflow_id = item.id and other.role = 'owner'
        and not (other.user_id = any(p_user_ids))
    )
  union all
  select 'chat'::text, item.id, null::text, 'delete'::text
  from public.chats item
  where item.org_id = p_org_id and item.project_id is null
    and (
      item.user_id = any(p_user_ids)
      or exists (
        select 1 from public.chat_access_grants held
        join public.user_profiles departing on lower(departing.email) = held.email
        where held.chat_id = item.id and held.role = 'owner'
          and departing.user_id = any(p_user_ids)
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = item.user_id
        and not (creator.user_id = any(p_user_ids))
    )
    and not exists (
      select 1 from public.chat_access_grants other
      join public.user_profiles profile on lower(profile.email) = other.email
      join public.org_members holder
        on holder.org_id = p_org_id and holder.user_id = profile.user_id
      where other.chat_id = item.id and other.role = 'owner'
        and not (holder.user_id = any(p_user_ids))
    )
  union all
  select 'tabular_review'::text, item.id, null::text, 'delete'::text
  from public.tabular_reviews item
  where item.org_id = p_org_id and item.project_id is null
    and (
      item.user_id = any(p_user_ids)
      or exists (
        select 1 from public.tabular_review_access_grants held
        join public.user_profiles departing on lower(departing.email) = held.email
        where held.tabular_review_id = item.id and held.role = 'owner'
          and departing.user_id = any(p_user_ids)
      )
    )
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = item.user_id
        and not (creator.user_id = any(p_user_ids))
    )
    and not exists (
      select 1 from public.tabular_review_access_grants other
      join public.user_profiles profile on lower(profile.email) = other.email
      join public.org_members holder
        on holder.org_id = p_org_id and holder.user_id = profile.user_id
      where other.tabular_review_id = item.id and other.role = 'owner'
        and not (holder.user_id = any(p_user_ids))
    )
  union all
  select 'document'::text, d.id, null::text, 'delete'::text
  from public.documents d
  where d.org_id = p_org_id
    and d.project_id is null and d.workflow_id is null
    and d.user_id = any(p_user_ids);
$$;

create or replace function public.org_member_sole_owned_items(
  p_org_id uuid,
  p_user_id uuid
)
returns table (kind text, item_id uuid, title text)
language sql
stable
set search_path = public
as $$
  select item.kind, item.item_id, item.title
  from public.org_members_departure_items(p_org_id, array[p_user_id]) item
  where item.disposition = 'transfer';
$$;

create or replace function public.org_member_private_standalone(
  p_org_id uuid,
  p_user_id uuid
)
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public
as $$
  select item.kind, item.item_id
  from public.org_members_departure_items(p_org_id, array[p_user_id]) item
  where item.disposition = 'delete'
    and item.kind in ('chat', 'tabular_review', 'document');
$$;

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

  -- An organization owner already owns every public item. Its override
  -- guard deliberately rejects redundant grants, so do not insert one.
  if exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = p_to_user_id and m.role = 'owner'
  ) then
    select count(*)::integer into assigned
    from public.org_member_sole_owned_items(p_org_id, p_from_user_id);
    return assigned;
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

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
declare gone record;
begin
  -- Serialize departures from the same organization, so two remaining
  -- owners cannot both see the other as staying during concurrent removal.
  perform 1 from public.organizations where id = old.org_id for update;
  -- Inspect ownership before deleting the departing member's grants: a
  -- member may be the last owner by a grant rather than as the creator.
  -- One snapshot identifies all items before cascading deletes start.
  if public.org_is_team(old.org_id) then
    for gone in
      select * from public.org_members_departure_items(old.org_id, array[old.user_id])
      where disposition = 'delete'
    loop
      if gone.kind = 'project' then
        delete from public.projects where id = gone.item_id;
      elsif gone.kind = 'workflow' then
        delete from public.workflows where id = gone.item_id;
      elsif gone.kind = 'chat' then
        delete from public.chats where id = gone.item_id;
      elsif gone.kind = 'tabular_review' then
        delete from public.tabular_reviews where id = gone.item_id;
      elsif gone.kind = 'document' then
        delete from public.documents where id = gone.item_id;
      end if;
    end loop;
  end if;
  -- Project/workflow foreign keys delete their contained items. Document
  -- version deletion queues durable stored-file cleanup through its trigger.
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

revoke all on function public.org_members_departure_items(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.org_members_departure_items(uuid, uuid[])
  to service_role;

-- BEFORE is essential: the membership foreign keys would otherwise cascade
-- away the last owner's explicit grant before the cleanup can inspect it.
drop trigger if exists org_members_cleanup_access_overrides on public.org_members;
create trigger org_members_cleanup_access_overrides before delete
  on public.org_members for each row
  execute procedure public.cleanup_removed_org_member_overrides();
