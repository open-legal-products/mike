-- Migration date: 2026-09-22
-- Independent Gmail/Calendar grants and immutable, single-use action approvals.
create table if not exists public.user_google_workspace_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'google-calendar')),
  grant_id uuid not null default gen_random_uuid(),
  account_email text not null, account_id text not null,
  encrypted_access_token text not null, access_token_iv text not null, access_token_tag text not null,
  encrypted_refresh_token text not null, refresh_token_iv text not null, refresh_token_tag text not null,
  scope text not null, expires_at timestamptz not null,
  write_enabled boolean not null default false,
  primary key (user_id, provider)
);
create table if not exists public.google_workspace_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'google-calendar')),
  state_hash text not null unique,
  encrypted_state_config text not null, state_config_iv text not null, state_config_tag text not null,
  write_enabled boolean not null default false,
  expires_at timestamptz not null
);
create table if not exists public.google_workspace_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'google-calendar')),
  grant_id uuid not null,
  encrypted_payload text not null, payload_iv text not null, payload_tag text not null,
  status text not null default 'pending' check (status in ('pending','executing','succeeded','failed','uncertain','rejected')),
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  result_message text
);
create index if not exists google_workspace_actions_owner on public.google_workspace_actions(user_id, created_at desc);
create index if not exists google_workspace_states_owner on public.google_workspace_oauth_states(user_id, provider);
alter table public.user_google_workspace_tokens enable row level security;
alter table public.google_workspace_oauth_states enable row level security;
alter table public.google_workspace_actions enable row level security;
revoke all on public.user_google_workspace_tokens, public.google_workspace_oauth_states, public.google_workspace_actions from public, anon, authenticated;
grant select, insert, update, delete on public.user_google_workspace_tokens, public.google_workspace_oauth_states, public.google_workspace_actions to service_role;

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
  values (v_state.user_id, p_provider, p_tokens->>'account_email', p_tokens->>'account_id', p_tokens->>'encrypted_access_token', p_tokens->>'access_token_iv', p_tokens->>'access_token_tag', p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv', p_tokens->>'refresh_token_tag', p_tokens->>'scope', (p_tokens->>'expires_at')::timestamptz, v_state.write_enabled)
  on conflict (user_id, provider) do update set
    grant_id = gen_random_uuid(), account_email = excluded.account_email, account_id = excluded.account_id, encrypted_access_token = excluded.encrypted_access_token,
    access_token_iv = excluded.access_token_iv, access_token_tag = excluded.access_token_tag,
    encrypted_refresh_token = excluded.encrypted_refresh_token, refresh_token_iv = excluded.refresh_token_iv, refresh_token_tag = excluded.refresh_token_tag,
    scope = excluded.scope, expires_at = excluded.expires_at, write_enabled = excluded.write_enabled;
  update public.google_workspace_actions set status = 'rejected', result_message = 'Connection replaced. Request a new proposal.' where user_id = v_state.user_id and provider = p_provider and status = 'pending';
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
  update public.google_workspace_actions set status = 'rejected', result_message = 'Connection removed.' where user_id = p_user_id and provider = p_provider and status = 'pending';
end;
$$;

-- This is the authorization boundary. Only the authenticated review endpoint
-- calls it; model tools can create proposals but cannot claim them.
create or replace function public.claim_google_workspace_action(p_user_id uuid, p_action_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_action public.google_workspace_actions;
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return null; end if;
  update public.google_workspace_actions a set status = 'executing'
  where a.id = p_action_id and a.user_id = p_user_id and a.status = 'pending' and a.expires_at > now()
    and exists (select 1 from public.user_google_workspace_tokens t where t.user_id = a.user_id and t.provider = a.provider and t.grant_id = a.grant_id and t.write_enabled)
  returning a.* into v_action;
  if not found then return null; end if;
  return to_jsonb(v_action);
end;
$$;
revoke all on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text), public.claim_google_workspace_action(uuid,uuid) from public, anon, authenticated;
grant execute on function public.complete_google_workspace_oauth(text,text,jsonb), public.disconnect_google_workspace(uuid,text), public.claim_google_workspace_action(uuid,uuid) to service_role;
