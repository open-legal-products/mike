-- Migration date: 2026-09-21
-- Native Google Drive integration.
--
-- First-party Drive tools that call the GA Drive REST API directly with a
-- per-user OAuth token — no dependency on Google's preview-gated MCP server.
-- One token row per user (connecting again overwrites), plus short-lived
-- OAuth state rows for the PKCE flow. Both tables are service-role only:
-- RLS is enabled with no user policies, so only the backend (service key)
-- can read the encrypted tokens.

CREATE TABLE IF NOT EXISTS public.user_google_drive_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  scope text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_google_drive_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.google_drive_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  encrypted_state_config text NOT NULL,
  state_config_iv text NOT NULL,
  state_config_tag text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_drive_oauth_states ENABLE ROW LEVEL SECURITY;

-- Grant hardening, mirroring backend/schema.sql. On hosted Supabase, default
-- privileges hand anon/authenticated access to every new table in public;
-- these tables hold encrypted OAuth tokens, so strip the browser roles and
-- grant the backend's service_role its data privileges explicitly.
revoke all on public.user_google_drive_tokens from anon, authenticated;
revoke all on public.google_drive_oauth_states from anon, authenticated;

grant select, insert, update, delete
  on public.user_google_drive_tokens
  to service_role;
grant select, insert, update, delete
  on public.google_drive_oauth_states
  to service_role;

-- Serialize connection replacement/disconnect on the owning auth row. State is
-- consumed in the same transaction as the token write: cancelled, expired or
-- replayed callbacks cannot recreate a connection after disconnect.
create or replace function public.complete_google_drive_oauth(p_state_hash text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_consumed uuid;
begin
  select user_id into v_user_id from public.google_drive_oauth_states
    where state_hash = p_state_hash;
  if not found then return false; end if;
  perform 1 from auth.users where id = v_user_id for update;
  if not found then return false; end if;
  delete from public.google_drive_oauth_states
    where state_hash = p_state_hash and user_id = v_user_id and expires_at > now()
    returning user_id into v_consumed;
  if not found then return false; end if;
  insert into public.user_google_drive_tokens (
    user_id, encrypted_access_token, access_token_iv, access_token_tag,
    encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at
  ) values (
    v_user_id, p_tokens->>'encrypted_access_token', p_tokens->>'access_token_iv',
    p_tokens->>'access_token_tag', p_tokens->>'encrypted_refresh_token',
    p_tokens->>'refresh_token_iv', p_tokens->>'refresh_token_tag',
    p_tokens->>'scope', (p_tokens->>'expires_at')::timestamptz
  ) on conflict (user_id) do update set
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

create or replace function public.disconnect_google_drive(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token jsonb;
begin
  perform 1 from auth.users where id = p_user_id for update;
  if not found then return null; end if;
  delete from public.google_drive_oauth_states where user_id = p_user_id;
  delete from public.user_google_drive_tokens where user_id = p_user_id
    returning to_jsonb(user_google_drive_tokens) into v_token;
  return v_token;
end;
$$;
revoke all on function public.disconnect_google_drive(uuid) from public, anon, authenticated;
grant execute on function public.disconnect_google_drive(uuid) to service_role;
