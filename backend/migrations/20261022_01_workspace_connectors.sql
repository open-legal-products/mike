-- Migration date: 2026-10-22
--
-- Connectors, per workspace.
--
-- MCP, Google Drive, Gmail and Calendar connections belonged to the account
-- and were switched off in every organization's workspace. CourtListener had
-- one account-wide switch and one personal token used everywhere.
--
-- A person now keeps a separate set of connections for Personal and for each
-- team organization they belong to. Each is private to them, like their
-- workspace memory: not shared with the organization and not usable by its
-- other members. A conversation uses only the connections of the workspace it
-- is in.
--
--   <connector table>.org_id   the organization a connection is for, or null
--                              for Personal
--   user_courtlistener_connections
--                              the CourtListener switch and the person's own
--                              token, per workspace (formerly
--                              user_profiles.legal_research_us and the
--                              'courtlistener' row of user_api_keys)
--
-- A workspace connection exists only while its person is a member: it is
-- tied to the membership row and goes with it, so leaving, being removed and
-- the organization being purged all delete the stored credentials.
--
-- Existing connections become Personal. CourtListener settings are copied to
-- Personal and to every team organization the person belongs to, so lookups
-- keep working where they worked before.
--
-- Safe to re-run: add column if not exists, drop-before-create for
-- constraints and replaced functions, guarded backfills.

-- ---------------------------------------------------------------------------
-- MCP connectors. Tokens, tools, OAuth states and audit rows hang off the
-- connector and follow it.
-- ---------------------------------------------------------------------------

alter table public.user_mcp_connectors
  add column if not exists org_id uuid;

alter table public.user_mcp_connectors
  drop constraint if exists user_mcp_connectors_workspace_member_fkey;
alter table public.user_mcp_connectors
  add constraint user_mcp_connectors_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

drop index if exists public.idx_user_mcp_connectors_user;
create index if not exists idx_user_mcp_connectors_user_workspace
  on public.user_mcp_connectors(user_id, org_id);
create index if not exists idx_user_mcp_connectors_org
  on public.user_mcp_connectors(org_id) where org_id is not null;

-- ---------------------------------------------------------------------------
-- Google Drive: one grant per person per workspace.
-- ---------------------------------------------------------------------------

alter table public.user_google_drive_tokens
  add column if not exists id uuid not null default gen_random_uuid();
alter table public.user_google_drive_tokens
  add column if not exists org_id uuid;

alter table public.user_google_drive_tokens
  drop constraint if exists user_google_drive_tokens_pkey;
alter table public.user_google_drive_tokens
  add constraint user_google_drive_tokens_pkey primary key (id);

-- Null is Personal and must collide with itself.
alter table public.user_google_drive_tokens
  drop constraint if exists user_google_drive_tokens_workspace_key;
alter table public.user_google_drive_tokens
  add constraint user_google_drive_tokens_workspace_key
  unique nulls not distinct (user_id, org_id);

alter table public.user_google_drive_tokens
  drop constraint if exists user_google_drive_tokens_workspace_member_fkey;
alter table public.user_google_drive_tokens
  add constraint user_google_drive_tokens_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

create index if not exists idx_user_google_drive_tokens_org
  on public.user_google_drive_tokens(org_id) where org_id is not null;

-- ---------------------------------------------------------------------------
-- Gmail and Calendar: one grant per person per workspace per service.
-- ---------------------------------------------------------------------------

alter table public.user_google_workspace_tokens
  add column if not exists id uuid not null default gen_random_uuid();
alter table public.user_google_workspace_tokens
  add column if not exists org_id uuid;

alter table public.user_google_workspace_tokens
  drop constraint if exists user_google_workspace_tokens_pkey;
alter table public.user_google_workspace_tokens
  add constraint user_google_workspace_tokens_pkey primary key (id);

alter table public.user_google_workspace_tokens
  drop constraint if exists user_google_workspace_tokens_workspace_key;
alter table public.user_google_workspace_tokens
  add constraint user_google_workspace_tokens_workspace_key
  unique nulls not distinct (user_id, org_id, provider);

alter table public.user_google_workspace_tokens
  drop constraint if exists user_google_workspace_tokens_workspace_member_fkey;
alter table public.user_google_workspace_tokens
  add constraint user_google_workspace_tokens_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

create index if not exists idx_user_google_workspace_tokens_org
  on public.user_google_workspace_tokens(org_id) where org_id is not null;

-- A pending Google sign-in remembers the workspace it was started in, so the
-- callback completes that workspace's grant and no other.
alter table public.google_workspace_oauth_states
  add column if not exists org_id uuid;

alter table public.google_workspace_oauth_states
  drop constraint if exists google_workspace_oauth_states_workspace_member_fkey;
alter table public.google_workspace_oauth_states
  add constraint google_workspace_oauth_states_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

create or replace function public.complete_google_drive_oauth(p_state_hash text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_org_id uuid;
begin
  select user_id into v_user_id from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive';
  if not found then return false; end if;
  perform 1 from auth.users where id = v_user_id for update;
  if not found then return false; end if;
  -- The workspace the sign-in was started in.
  delete from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive'
      and user_id = v_user_id and expires_at > now()
    returning org_id into v_org_id;
  if not found then return false; end if;
  insert into public.user_google_drive_tokens (
    user_id, org_id, account_email, encrypted_access_token, access_token_iv, access_token_tag,
    encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at
  ) values (
    v_user_id, v_org_id, p_tokens->>'account_email', p_tokens->>'encrypted_access_token',
    p_tokens->>'access_token_iv', p_tokens->>'access_token_tag',
    p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv',
    p_tokens->>'refresh_token_tag', p_tokens->>'scope',
    (p_tokens->>'expires_at')::timestamptz
  ) on conflict (user_id, org_id) do update set
    grant_id = gen_random_uuid(),
    account_email = excluded.account_email,
    encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, updated_at = now();
  return true;
end;
$$;
revoke all on function public.complete_google_drive_oauth(text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_google_drive_oauth(text, jsonb) to service_role;

-- p_org_id defaults to Personal, so a backend that predates this migration
-- still disconnects the connection it knows about.
drop function if exists public.disconnect_google_drive(uuid);
create or replace function public.disconnect_google_drive(p_user_id uuid, p_org_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token jsonb;
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return null; end if;
  delete from public.google_workspace_oauth_states
    where user_id = p_user_id and provider = 'google-drive'
      and org_id is not distinct from p_org_id;
  delete from public.user_google_drive_tokens
    where user_id = p_user_id and org_id is not distinct from p_org_id
    returning to_jsonb(user_google_drive_tokens) into v_token;
  return v_token;
end;
$$;
revoke all on function public.disconnect_google_drive(uuid, uuid) from public, anon, authenticated;
grant execute on function public.disconnect_google_drive(uuid, uuid) to service_role;

create or replace function public.complete_google_workspace_oauth(p_state_hash text, p_provider text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_state public.google_workspace_oauth_states;
begin
  select * into v_state from public.google_workspace_oauth_states where state_hash = p_state_hash and provider = p_provider;
  if not found then return false; end if;
  perform 1 from auth.users where id = v_state.user_id for update;
  if not found then return false; end if;
  delete from public.google_workspace_oauth_states where state_hash = p_state_hash and provider = p_provider and expires_at > now() returning * into v_state;
  if not found then return false; end if;
  insert into public.user_google_workspace_tokens(user_id, org_id, provider, account_email, account_id, encrypted_access_token, access_token_iv, access_token_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at, write_enabled)
  values (v_state.user_id, v_state.org_id, p_provider, p_tokens->>'account_email', p_tokens->>'account_id', p_tokens->>'encrypted_access_token', p_tokens->>'access_token_iv', p_tokens->>'access_token_tag', p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv', p_tokens->>'refresh_token_tag', p_tokens->>'scope', (p_tokens->>'expires_at')::timestamptz, coalesce((p_tokens->>'write_enabled')::boolean, false))
  on conflict (user_id, org_id, provider) do update set
    grant_id = gen_random_uuid(), account_email = excluded.account_email, account_id = excluded.account_id, encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token, refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, write_enabled = excluded.write_enabled;
  return true;
end;
$$;

drop function if exists public.disconnect_google_workspace(uuid, text);
create or replace function public.disconnect_google_workspace(p_user_id uuid, p_provider text, p_org_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return; end if;
  delete from public.google_workspace_oauth_states
    where user_id = p_user_id and provider = p_provider
      and org_id is not distinct from p_org_id;
  delete from public.user_google_workspace_tokens
    where user_id = p_user_id and provider = p_provider
      and org_id is not distinct from p_org_id;
end;
$$;

revoke all on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- CourtListener: the switch and the person's own token, per workspace. An
-- organization's own token stays in org_api_keys and is laid over the
-- member's when it has one.
-- ---------------------------------------------------------------------------

create table if not exists public.user_courtlistener_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid,
  enabled boolean not null default true,
  -- The person's own API token for this workspace, encrypted like
  -- user_api_keys. Null when they have not saved one.
  encrypted_key text,
  iv text,
  auth_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_courtlistener_connections_key_check check (
    (encrypted_key is null) = (iv is null) and (iv is null) = (auth_tag is null)
  ),
  constraint user_courtlistener_connections_workspace_key
    unique nulls not distinct (user_id, org_id),
  constraint user_courtlistener_connections_workspace_member_fkey
    foreign key (org_id, user_id)
    references public.org_members(org_id, user_id) on delete cascade
);

create index if not exists idx_user_courtlistener_connections_org
  on public.user_courtlistener_connections(org_id) where org_id is not null;

alter table public.user_courtlistener_connections enable row level security;
revoke all on public.user_courtlistener_connections from public, anon, authenticated;
grant select, insert, update, delete
  on public.user_courtlistener_connections
  to service_role;

-- Copy each person's switch and token to Personal and to every team
-- organization they belong to. A token the person had switched off was not
-- used, so it is not copied. Rows that already exist are left alone, so a
-- re-run never overwrites a choice made since.
insert into public.user_courtlistener_connections (
  user_id, org_id, enabled, encrypted_key, iv, auth_tag
)
select
  people.user_id,
  workspaces.org_id,
  coalesce(profiles.legal_research_us, true),
  keys.encrypted_key,
  keys.iv,
  keys.auth_tag
from (
  select user_id from public.user_api_keys where provider = 'courtlistener'
  union
  select user_id from public.user_profiles where legal_research_us = false
) people
cross join lateral (
  select null::uuid as org_id
  union all
  select members.org_id
  from public.org_members members
  join public.organizations orgs on orgs.id = members.org_id
  where members.user_id = people.user_id
    and orgs.kind = 'team'
    and orgs.deleted_at is null
) workspaces
left join public.user_profiles profiles on profiles.user_id = people.user_id
left join public.user_api_keys keys
  on keys.user_id = people.user_id
  and keys.provider = 'courtlistener'
  and keys.enabled
where exists (select 1 from auth.users u where u.id = people.user_id)
on conflict (user_id, org_id) do nothing;

-- The token now lives with its workspace. user_profiles.legal_research_us is
-- left in place for a backend that predates this migration, and no longer
-- read.
delete from public.user_api_keys where provider = 'courtlistener';
