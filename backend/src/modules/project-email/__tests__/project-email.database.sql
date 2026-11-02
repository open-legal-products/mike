-- Run against a disposable LOCAL database initialized with backend/schema.sql.
-- These assertions use actual transactions/lifecycle functions, not a DB mock.
begin;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception '%',m; end if; end; $$;
do $$
declare
  actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); folder uuid:=gen_random_uuid();
  grant_id uuid:=gen_random_uuid(); preview uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid(); rival uuid:=gen_random_uuid();
  item jsonb; claimed jsonb; again jsonb; v jsonb; did uuid; org uuid:=gen_random_uuid(); org_project uuid:=gen_random_uuid(); org_preview uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'intake-actor@example.invalid'),(outsider,'intake-outsider@example.invalid');
  insert into public.projects(id,user_id,name) values(project,actor,'Synthetic email intake');
  insert into public.project_subfolders(id,project_id,name) values(folder,project,'Synthetic folder');
  insert into public.user_google_workspace_tokens(user_id,provider,grant_id,account_email,account_id,encrypted_access_token,access_token_iv,access_token_tag,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,scope,expires_at)
    values(actor,'gmail',grant_id,'intake@example.invalid','fixture-mailbox','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic','gmail.readonly',now()+interval '1 day');
  perform public.create_project_email_preview(jsonb_build_object('id',preview,'user_id',actor,'project_id',project,'folder_id',folder,'grant_id',grant_id,'account_id','fixture-mailbox','account_email','intake@example.invalid','query','subject:synthetic','manifest','{}'::jsonb,'expires_at',now()+interval '1 hour'));
  perform pg_temp.assert_true(exists(select 1 from public.db_jobs where kind='project-email.cleanup' and payload->>'previewId'=preview::text),'preview expiry cleanup durably scheduled');
  update public.project_email_previews set confirmed_at=now(),selected_ids='["m1"]' where id=preview;
  item:=jsonb_build_object('user_id',actor,'project_id',project,'account_id','fixture-mailbox','message_id','m1','part_key','body','thread_id','t1','filename','Email-m1.docx');
  claimed:=public.claim_project_email_item(item,lease);
  again:=public.claim_project_email_item(item,rival);
  perform pg_temp.assert_true(claimed->>'id'=again->>'id' and again->>'lease_id'=lease::text,'concurrent rival cannot steal a live lease or create a duplicate');
  perform pg_temp.assert_true(not public.stage_project_email_item((claimed->>'id')::uuid,rival,'wrong'),'stale lease cannot stage bytes');
  perform pg_temp.assert_true(public.stage_project_email_item((claimed->>'id')::uuid,lease,'synthetic/source.docx'),'current lease can stage bytes');
  perform pg_temp.assert_true(exists(select 1 from public.db_jobs where kind='document.cleanup' and payload->'keys' ? 'synthetic/source.docx'),'staging has a durable crash-cleanup pointer');
  v:=jsonb_build_object('filename','Email-m1.docx','file_type','docx','storage_path','synthetic/source.docx','content_sha256',repeat('a',64),'size_bytes',10);
  begin perform public.commit_project_email_document((claimed->>'id')::uuid,rival,preview,v); raise exception 'rival unexpectedly committed'; exception when raise_exception then if sqlerrm<>'email_intake_lease_lost' then raise; end if; end;
  begin perform public.commit_project_email_document((claimed->>'id')::uuid,lease,preview,v||'{"size_bytes":"bad"}'); raise exception 'invalid version unexpectedly committed'; exception when invalid_text_representation then null; end;
  perform pg_temp.assert_true(not exists(select 1 from public.documents where id=(claimed->>'reserved_document_id')::uuid),'version failure rolls back document creation');
  perform pg_temp.assert_true((select status='processing' from public.project_email_items where id=(claimed->>'id')::uuid),'failed transaction cannot advance processed state');
  update public.user_google_workspace_tokens set enabled=false where user_id=actor;
  begin perform public.commit_project_email_document((claimed->>'id')::uuid,lease,preview,v); raise exception 'disabled connection unexpectedly committed'; exception when raise_exception then if sqlerrm<>'email_intake_connection_changed' then raise; end if; end;
  update public.user_google_workspace_tokens set enabled=true where user_id=actor;
  delete from public.project_subfolders where id=folder;
  begin perform public.commit_project_email_document((claimed->>'id')::uuid,lease,preview,v); raise exception 'deleted folder unexpectedly committed'; exception when raise_exception then if sqlerrm<>'email_intake_destination_changed' then raise; end if; end;
  update public.project_email_previews set folder_id=null where id=preview; -- explicit fixture repair, never production fallback
  again:=public.commit_project_email_document((claimed->>'id')::uuid,lease,preview,v);
  did:=(again->>'document_id')::uuid;
  perform pg_temp.assert_true(again->>'status'='imported' and exists(select 1 from public.documents d join public.document_versions dv on dv.id=d.current_version_id where d.id=did and dv.id=(claimed->>'version_id')::uuid),'version activation and receipt commit together');
  perform pg_temp.assert_true(public.claim_project_email_item(item,rival)->>'status'='imported','confirmed replay remains imported');
  perform pg_temp.assert_true((select count(*)=1 from public.document_versions where document_id=did),'replay has exactly one version');
  -- Same bytes/name in another MIME part are separate evidence/provenance.
  again:=public.claim_project_email_item(item||'{"part_key":"0.1"}',rival);
  perform pg_temp.assert_true(again->>'id'<>claimed->>'id','distinct MIME parts are not filename/hash-deduplicated');
  again:=public.claim_project_email_item(item||'{"account_id":"other-mailbox"}',rival);
  perform pg_temp.assert_true(again->>'id'<>claimed->>'id','same Gmail ID in another mailbox is distinct');
  -- Reconnecting the same account changes grant but not durable import identity.
  update public.user_google_workspace_tokens set grant_id=gen_random_uuid() where user_id=actor;
  perform pg_temp.assert_true(public.claim_project_email_item(item,rival)->>'id'=claimed->>'id','same-account reconnect does not duplicate processed identities');
  delete from public.documents where id=did;
  perform pg_temp.assert_true(public.claim_project_email_item(item,rival)->>'status'='imported' and not exists(select 1 from public.documents where id=did),'deletion leaves an immutable receipt tombstone, no resurrection');
  -- Organization membership is rechecked by the commit transaction itself.
  insert into public.organizations(id,name,created_by) values(org,'Synthetic team',outsider);
  insert into public.org_members(org_id,user_id,role) values(org,outsider,'owner'),(org,actor,'member');
  insert into public.projects(id,name,user_id,org_id,visibility) values(org_project,'Synthetic shared team matter',outsider,org,'organization');
  insert into public.user_google_workspace_tokens(user_id,org_id,provider,grant_id,account_email,account_id,encrypted_access_token,access_token_iv,access_token_tag,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,scope,expires_at)
    values(actor,org,'gmail',grant_id,'intake@example.invalid','fixture-mailbox','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic','gmail.readonly',now()+interval '1 day');
  insert into public.project_email_previews(id,user_id,project_id,org_id,grant_id,account_id,account_email,query,manifest,selected_ids,confirmed_at)
    values(org_preview,actor,org_project,org,grant_id,'fixture-mailbox','intake@example.invalid','fixture','{}','["m1"]',now());
  item:=item||jsonb_build_object('project_id',org_project);
  claimed:=public.claim_project_email_item(item,lease);
  perform public.stage_project_email_item((claimed->>'id')::uuid,lease,'synthetic/org.docx');
  delete from public.org_members where user_id=actor and org_id=org;
  begin perform public.commit_project_email_document((claimed->>'id')::uuid,lease,org_preview,v||'{"storage_path":"synthetic/org.docx"}'); raise exception 'revoked membership unexpectedly committed'; exception when raise_exception then if sqlerrm<>'email_intake_access_changed' then raise; end if; end;
  perform pg_temp.assert_true(not exists(select 1 from public.documents where project_id=org_project),'membership revocation leaves no project document');
  perform pg_temp.assert_true(not has_table_privilege('authenticated','public.project_email_items','SELECT'),'browser cannot enumerate private provenance');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','public.commit_project_email_document(uuid,uuid,uuid,jsonb)','EXECUTE'),'browser cannot bypass confirmation/auth via RPC');
end $$;
rollback;
