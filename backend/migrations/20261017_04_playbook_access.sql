-- Migration date: 2026-10-17
-- Playbook access matches workflows: people are given a role (owner, editor
-- or viewer) instead of a bare list of addresses. A personal playbook is
-- shared by email; an organization's playbook is shared with its members,
-- who can also be denied a public one. Unlike a workflow, a public playbook
-- gives members view-and-run access by default; editing is granted per
-- person, because a playbook's rules are the organization's policy.
create table if not exists public.playbook_shares (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  shared_by_user_id uuid references auth.users(id) on delete set null,
  shared_with_email text not null,
  role text not null default 'viewer'
    check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  constraint playbook_shares_playbook_email_unique
    unique (playbook_id, shared_with_email),
  -- Canonical case, like workflow_shares: the unique constraint and the
  -- access lookup must agree on who a recipient is.
  constraint playbook_shares_email_lowercase
    check (shared_with_email = lower(shared_with_email))
);
create index if not exists idx_playbook_shares_email
  on public.playbook_shares(shared_with_email);

create table if not exists public.playbook_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null constraint playbook_org_access_overrides_role_check
    check (role in ('owner', 'editor', 'viewer', 'deny')),
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (playbook_id, user_id),
  -- Leaving the organization removes the grant.
  foreign key (org_id, user_id)
    references public.org_members(org_id, user_id) on delete cascade
);
create index if not exists idx_playbook_org_access_overrides_user
  on public.playbook_org_access_overrides(user_id);

-- Existing recipients could view and run, which is the viewer role.
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbooks'
      and column_name = 'shared_with') then
    insert into public.playbook_shares
      (playbook_id, shared_by_user_id, shared_with_email, role)
    select b.id, b.user_id, lower(trim(email)), 'viewer'
    from public.playbooks b, unnest(b.shared_with) as email
    where b.org_id is null and trim(email) <> ''
    on conflict (playbook_id, shared_with_email) do nothing;
  end if;
end $$;

alter table public.playbooks drop constraint if exists playbooks_visibility_check;
drop index if exists public.idx_playbooks_shared_with;
alter table public.playbooks drop column if exists shared_with;
alter table public.playbooks add constraint playbooks_visibility_check
  check (visibility in ('private', 'organization') and
    (org_id is not null or visibility = 'private'));

create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare resource_visibility text;
declare member_role text;
declare archived timestamptz;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id, p.visibility, p.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id, w.visibility, w.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.workflows w where w.id = new.workflow_id for update;
    when 'playbook_org_access_overrides' then
      -- Playbooks are never archived.
      select b.org_id, b.user_id, b.visibility, null::timestamptz
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.playbooks b where b.id = new.playbook_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if archived is not null then
    raise exception 'Archived work must be restored by an organization owner' using errcode='23514';
  end if;
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

drop trigger if exists playbook_org_access_overrides_guard
  on public.playbook_org_access_overrides;
create trigger playbook_org_access_overrides_guard before insert or update
  on public.playbook_org_access_overrides for each row
  execute procedure public.validate_org_access_override();

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
    delete from public.playbook_org_access_overrides o
    using public.playbooks b
    where o.org_id = new.org_id and o.user_id = new.user_id
      and b.id = o.playbook_id and b.visibility = 'organization';
  end if;
  return new;
end;
$$;

alter table public.playbook_shares enable row level security;
alter table public.playbook_org_access_overrides enable row level security;
revoke all privileges on table public.playbook_shares,
  public.playbook_org_access_overrides from anon, authenticated;
grant select, insert, update, delete on public.playbook_shares,
  public.playbook_org_access_overrides to service_role;
