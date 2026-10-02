-- Migration date: 2026-10-01
-- Connector write access by default, with an optional per-connector approval
-- step that runs inside the assistant turn.
--
-- * MCP connectors gain `require_write_approval`. Write tools
--   (`requires_confirmation`) were force-disabled because no approval step
--   existed; they are re-enabled once, when the column is first added, so a
--   re-run never overrides a later choice by the user.
-- * Google connections gain the same on/off, per-tool, and approval settings.
--   Google write access now follows the scopes Google actually granted, so the
--   OAuth state no longer records a requested write mode.
-- * Approvals are stored on the paused assistant message (an ask_inputs
--   approval item), so the out-of-turn Google proposal table is removed.
-- * Google Drive's pending OAuth states move into google_workspace_oauth_states
--   as provider 'google-drive', and google_drive_oauth_states is dropped. Drive
--   keeps its own token table; only the short-lived PKCE state rows move.

do $$
begin
  if to_regclass('public.user_mcp_connectors') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_mcp_connectors'
      and column_name = 'require_write_approval'
  ) then
    alter table public.user_mcp_connectors
      add column require_write_approval boolean not null default false;
    update public.user_mcp_connector_tools
      set enabled = true, updated_at = now()
      where requires_confirmation and not enabled;
  end if;
end;
$$;

alter table if exists public.user_google_drive_tokens
  add column if not exists enabled boolean not null default true,
  add column if not exists disabled_tools text[] not null default '{}';

alter table if exists public.user_google_workspace_tokens
  add column if not exists enabled boolean not null default true,
  add column if not exists require_write_approval boolean not null default false,
  add column if not exists disabled_tools text[] not null default '{}';

-- Reconnecting replaces the grant but keeps the user's connector settings.
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
  insert into public.user_google_workspace_tokens(user_id, provider, account_email, account_id, encrypted_access_token, access_token_iv, access_token_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at, write_enabled)
  values (v_state.user_id, p_provider, p_tokens->>'account_email', p_tokens->>'account_id', p_tokens->>'encrypted_access_token', p_tokens->>'access_token_iv', p_tokens->>'access_token_tag', p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv', p_tokens->>'refresh_token_tag', p_tokens->>'scope', (p_tokens->>'expires_at')::timestamptz, coalesce((p_tokens->>'write_enabled')::boolean, false))
  on conflict (user_id, provider) do update set
    grant_id = gen_random_uuid(), account_email = excluded.account_email, account_id = excluded.account_id, encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token, refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, write_enabled = excluded.write_enabled;
  return true;
end;
$$;

create or replace function public.disconnect_google_workspace(p_user_id uuid, p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return; end if;
  delete from public.google_workspace_oauth_states where user_id = p_user_id and provider = p_provider;
  delete from public.user_google_workspace_tokens where user_id = p_user_id and provider = p_provider;
end;
$$;

revoke all on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text) from public, anon, authenticated;
grant execute on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text) to service_role;

drop function if exists public.claim_google_workspace_action(uuid, uuid);
drop table if exists public.google_workspace_actions;
alter table if exists public.google_workspace_oauth_states drop column if exists write_enabled;

-- One OAuth state table for every Google connection. Safe to re-run: the
-- provider check is dropped before it is recreated, copied states skip
-- existing hashes, functions are replaced, and the old table is dropped only
-- if it still exists.
do $$
begin
  if to_regclass('public.google_workspace_oauth_states') is null then
    raise exception 'google_workspace_oauth_states is missing; apply 20260922_01_google_workspace.sql first';
  end if;
end;
$$;

alter table public.google_workspace_oauth_states
  drop constraint if exists google_workspace_oauth_states_provider_check;
alter table public.google_workspace_oauth_states
  add constraint google_workspace_oauth_states_provider_check
  check (provider in ('gmail', 'google-calendar', 'google-drive'));

-- Keep sign-ins that are in flight while this runs. Expired rows are dropped
-- with the table.
do $$
begin
  if to_regclass('public.google_drive_oauth_states') is not null then
    insert into public.google_workspace_oauth_states (
      id, user_id, provider, state_hash,
      encrypted_state_config, state_config_iv, state_config_tag, expires_at
    )
    select id, user_id, 'google-drive', state_hash,
      encrypted_state_config, state_config_iv, state_config_tag, expires_at
    from public.google_drive_oauth_states
    where expires_at > now()
    on conflict do nothing;
  end if;
end;
$$;

-- complete_google_drive_oauth still reads the table this migration drops until
-- 20261002_02_google_drive_account_email.sql redefines it against
-- google_workspace_oauth_states; apply these migrations together.

create or replace function public.disconnect_google_drive(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token jsonb;
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return null; end if;
  delete from public.google_workspace_oauth_states
    where user_id = p_user_id and provider = 'google-drive';
  delete from public.user_google_drive_tokens where user_id = p_user_id
    returning to_jsonb(user_google_drive_tokens) into v_token;
  return v_token;
end;
$$;
revoke all on function public.disconnect_google_drive(uuid) from public, anon, authenticated;
grant execute on function public.disconnect_google_drive(uuid) to service_role;

drop table if exists public.google_drive_oauth_states;
