-- Migration date: 2026-10-02
-- Record which Google account a Drive connection signed in as, for display in
-- the connector's Manage dialog. Null for connections made before this.
alter table public.user_google_drive_tokens
  add column if not exists account_email text;

-- The one definition of this function for the connector changes in
-- 20261001_01 and 20261002_01: it reads the merged OAuth state table, rotates
-- grant_id on reconnect, and records the account. Connection replacement and
-- disconnect serialize on the owning auth row, and state is consumed in the
-- same transaction as the token write, so a cancelled, expired or replayed
-- callback cannot recreate a connection after disconnect.
create or replace function public.complete_google_drive_oauth(p_state_hash text, p_tokens jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive';
  if not found then return false; end if;
  perform 1 from auth.users where id = v_user_id for update;
  if not found then return false; end if;
  delete from public.google_workspace_oauth_states
    where state_hash = p_state_hash and provider = 'google-drive'
      and user_id = v_user_id and expires_at > now();
  if not found then return false; end if;
  insert into public.user_google_drive_tokens (
    user_id, account_email, encrypted_access_token, access_token_iv, access_token_tag,
    encrypted_refresh_token, refresh_token_iv, refresh_token_tag, scope, expires_at
  ) values (
    v_user_id, p_tokens->>'account_email', p_tokens->>'encrypted_access_token',
    p_tokens->>'access_token_iv', p_tokens->>'access_token_tag',
    p_tokens->>'encrypted_refresh_token', p_tokens->>'refresh_token_iv',
    p_tokens->>'refresh_token_tag', p_tokens->>'scope',
    (p_tokens->>'expires_at')::timestamptz
  ) on conflict (user_id) do update set
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
