-- Run by scripts/test-google-workspace-db.sh in an isolated local PostgreSQL.
insert into public.user_mcp_connectors(id) values ('00000000-0000-0000-0000-000000000003');
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception '%',message; end if; end; $$;
select pg_temp.assert_true((select not read_only from public.user_mcp_connectors), 'MCP read-only defaults off');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.user_google_workspace_tokens','SELECT'), 'owner cannot read encrypted grants');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.user_google_workspace_tokens','UPDATE'), 'owner cannot change connector settings by direct DB writes');
select pg_temp.assert_true(not has_function_privilege('anon','public.complete_google_workspace_oauth(text,text,jsonb)','EXECUTE'), 'anon cannot complete OAuth');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.disconnect_google_workspace(uuid,text)','EXECUTE'), 'browser cannot directly disconnect');
select pg_temp.assert_true((select bool_and(relrowsecurity) from pg_class where relname in ('user_google_workspace_tokens','google_workspace_oauth_states')), 'RLS enabled');
select pg_temp.assert_true(to_regclass('public.google_workspace_actions') is null, 'out-of-turn proposal table removed');
select pg_temp.assert_true(not exists(select 1 from pg_proc where proname = 'claim_google_workspace_action'), 'proposal claim RPC removed');
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at) values ('00000000-0000-0000-0000-000000000001','gmail','state','x','x','x',now()+interval '10 minutes');
create temporary table patch as select '{"account_email":"other@example.com","account_id":"other","encrypted_access_token":"a","access_token_iv":"iv","access_token_tag":"tag","encrypted_refresh_token":"r","refresh_token_iv":"iv","refresh_token_tag":"tag","scope":"read write","expires_at":"2099-01-01T00:00:00Z","write_enabled":true}'::jsonb as data;
select pg_temp.assert_true(not complete_google_workspace_oauth('state','google-calendar',(select data from patch)),'cross-provider state denied');
select pg_temp.assert_true(complete_google_workspace_oauth('state','gmail',(select data from patch)),'state completes');
select pg_temp.assert_true(not complete_google_workspace_oauth('state','gmail',(select data from patch)),'state replay denied');
select pg_temp.assert_true((select write_enabled and enabled and not read_only and not require_write_approval and disabled_tools = '{}' from public.user_google_workspace_tokens),'granted write access recorded with default settings');
-- Reconnecting replaces the grant and follows the newly granted scopes, but
-- keeps the user's connector settings.
update public.user_google_workspace_tokens set enabled=false, read_only=true, require_write_approval=true, disabled_tools='{gmail_send}';
create temporary table prior as select grant_id from public.user_google_workspace_tokens;
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at) values ('00000000-0000-0000-0000-000000000001','gmail','new-state','x','x','x',now()+interval '10 minutes');
select pg_temp.assert_true(complete_google_workspace_oauth('new-state','gmail',(select data - 'write_enabled' from patch)),'replacement completes');
select pg_temp.assert_true((select grant_id <> (select grant_id from prior) from public.user_google_workspace_tokens),'replacement issues a new grant');
select pg_temp.assert_true((select not write_enabled from public.user_google_workspace_tokens),'withheld write access recorded as read-only');
select pg_temp.assert_true((select not enabled and read_only and require_write_approval and disabled_tools = '{gmail_send}' from public.user_google_workspace_tokens),'settings survive reconnect');
select disconnect_google_workspace('00000000-0000-0000-0000-000000000001','gmail');
select pg_temp.assert_true(not exists(select 1 from public.user_google_workspace_tokens),'disconnect removes grant');
select pg_temp.assert_true(not exists(select 1 from public.google_workspace_oauth_states),'disconnect removes states');

-- Drive approvals must not survive replacing a connection, while the user's
-- approval and per-tool settings must survive it.
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at) values ('00000000-0000-0000-0000-000000000001','google-drive','drive-state','x','x','x',now()+interval '10 minutes');
select pg_temp.assert_true(complete_google_drive_oauth('drive-state',(select data from patch)),'Drive connects');
select pg_temp.assert_true((select grant_id is not null and not read_only and not require_write_approval and account_email = 'other@example.com' from public.user_google_drive_tokens),'Drive grant identity, account and default settings');
create temporary table prior_drive as select grant_id from public.user_google_drive_tokens;
update public.user_google_drive_tokens set require_write_approval=true, read_only=true, disabled_tools='{google_drive_trash_file}', enabled=false;
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at) values ('00000000-0000-0000-0000-000000000001','google-drive','drive-new-state','x','x','x',now()+interval '10 minutes');
select pg_temp.assert_true(complete_google_drive_oauth('drive-new-state',(select data from patch)),'Drive reconnects');
select pg_temp.assert_true((select grant_id <> (select grant_id from prior_drive) and require_write_approval and read_only and not enabled and disabled_tools='{google_drive_trash_file}' from public.user_google_drive_tokens),'Drive reconnect rotates identity and preserves settings');
select pg_temp.assert_true(not complete_google_drive_oauth('drive-new-state',(select data from patch)),'Drive callback cannot replay');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.user_google_drive_tokens','UPDATE'),'browser cannot alter Drive grants or settings');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.complete_google_drive_oauth(text,jsonb)','EXECUTE'),'browser cannot complete Drive grants');
select disconnect_google_drive('00000000-0000-0000-0000-000000000001');
select pg_temp.assert_true(not exists(select 1 from public.user_google_drive_tokens),'Drive disconnect removes grant');
