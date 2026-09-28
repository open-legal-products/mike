-- Run by scripts/test-google-workspace-db.sh in an isolated local PostgreSQL.
insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception '%',message; end if; end; $$;
select pg_temp.assert_true(not has_table_privilege('authenticated','public.user_google_workspace_tokens','SELECT'), 'owner cannot read encrypted grants');
select pg_temp.assert_true(not has_table_privilege('anon','public.google_workspace_actions','INSERT'), 'anon cannot propose');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.google_workspace_actions','UPDATE'), 'owner cannot forge approval by direct DB writes');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.claim_google_workspace_action(uuid,uuid)','EXECUTE'), 'browser cannot directly claim RPC');
select pg_temp.assert_true(not has_function_privilege('anon','public.complete_google_workspace_oauth(text,text,jsonb)','EXECUTE'), 'anon cannot complete OAuth');
select pg_temp.assert_true((select bool_and(relrowsecurity) from pg_class where relname in ('user_google_workspace_tokens','google_workspace_oauth_states','google_workspace_actions')), 'RLS enabled');
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at,write_enabled) values ('00000000-0000-0000-0000-000000000001','gmail','state','x','x','x',now()+interval '10 minutes',true);
create temporary table patch as select '{"account_email":"other@example.com","account_id":"other","encrypted_access_token":"a","access_token_iv":"iv","access_token_tag":"tag","encrypted_refresh_token":"r","refresh_token_iv":"iv","refresh_token_tag":"tag","scope":"read write","expires_at":"2099-01-01T00:00:00Z"}'::jsonb as data;
select pg_temp.assert_true(not complete_google_workspace_oauth('state','google-calendar',(select data from patch)),'cross-provider state denied');
select pg_temp.assert_true(complete_google_workspace_oauth('state','gmail',(select data from patch)),'state completes');
select pg_temp.assert_true(not complete_google_workspace_oauth('state','gmail',(select data from patch)),'state replay denied');
insert into public.google_workspace_actions(id,user_id,provider,grant_id,encrypted_payload,payload_iv,payload_tag,expires_at)
select '10000000-0000-0000-0000-000000000001',user_id,provider,grant_id,'x','x','x',now()+interval '10 minutes' from public.user_google_workspace_tokens;
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001') is null,'cross-user approval denied');
update public.user_google_workspace_tokens set write_enabled=false;
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001') is null,'readonly approval denied');
update public.user_google_workspace_tokens set write_enabled=true;
update public.google_workspace_actions set expires_at=now()-interval '1 second';
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001') is null,'expired approval denied');
update public.google_workspace_actions set expires_at=now()+interval '10 minutes';
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001')->>'status'='executing','approval claimed');
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001') is null,'approval replay denied');
insert into public.google_workspace_actions(id,user_id,provider,grant_id,encrypted_payload,payload_iv,payload_tag,expires_at)
select '10000000-0000-0000-0000-000000000002',user_id,provider,grant_id,'x','x','x',now()+interval '10 minutes' from public.user_google_workspace_tokens;
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at,write_enabled) values ('00000000-0000-0000-0000-000000000001','gmail','new-state','x','x','x',now()+interval '10 minutes',true);
select pg_temp.assert_true(complete_google_workspace_oauth('new-state','gmail',(select data from patch)),'replacement completes');
select pg_temp.assert_true(claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002') is null,'replacement invalidates proposal');
select disconnect_google_workspace('00000000-0000-0000-0000-000000000001','gmail');
select pg_temp.assert_true(not exists(select 1 from public.user_google_workspace_tokens),'disconnect removes grant');
select pg_temp.assert_true(not exists(select 1 from public.google_workspace_oauth_states),'disconnect removes states');
-- Leave a pending action for the shell's genuinely concurrent claim test.
insert into public.google_workspace_oauth_states(user_id,provider,state_hash,encrypted_state_config,state_config_iv,state_config_tag,expires_at,write_enabled) values ('00000000-0000-0000-0000-000000000001','gmail','race-state','x','x','x',now()+interval '10 minutes',true);
select complete_google_workspace_oauth('race-state','gmail',(select data from patch));
insert into public.google_workspace_actions(id,user_id,provider,grant_id,encrypted_payload,payload_iv,payload_tag,expires_at)
select '10000000-0000-0000-0000-000000000003',user_id,provider,grant_id,'x','x','x',now()+interval '10 minutes' from public.user_google_workspace_tokens;
