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
-- A partial message has durable per-item outcomes: an unreadable body is
-- excluded, while a supported attachment follows the normal version lifecycle.
do $$
declare
  actor uuid:=gen_random_uuid();project uuid:=gen_random_uuid();grant_id uuid:=gen_random_uuid();preview uuid:=gen_random_uuid();
  body_lease uuid:=gen_random_uuid();attachment_lease uuid:=gen_random_uuid();
  reason text:='Email body could not be fully read within the supported text formats and limits; inspect the original email.';
  body_item jsonb;attachment_item jsonb;body_claim jsonb;body_terminal jsonb;attachment_claim jsonb;committed jsonb;again jsonb;v jsonb;
  rows_changed integer;
begin
  insert into auth.users(id,email) values(actor,'partial-intake@example.invalid');
  insert into public.projects(id,user_id,name) values(project,actor,'Synthetic partial email intake');
  insert into public.user_google_workspace_tokens(user_id,provider,grant_id,account_email,account_id,encrypted_access_token,access_token_iv,access_token_tag,encrypted_refresh_token,refresh_token_iv,refresh_token_tag,scope,expires_at)
    values(actor,'gmail',grant_id,'partial-intake@example.invalid','partial-mailbox','synthetic','synthetic','synthetic','synthetic','synthetic','synthetic','gmail.readonly',now()+interval '1 day');
  perform public.create_project_email_preview(jsonb_build_object('id',preview,'user_id',actor,'project_id',project,
    'grant_id',grant_id,'account_id','partial-mailbox','account_email','partial-intake@example.invalid','query','subject:synthetic-partial',
    'manifest',jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('id','partial-m1','threadId','partial-t1',
      'subject','Synthetic partial source','from','sender@example.invalid','to','partial-intake@example.invalid','date','2 November 2026',
      'fingerprint',repeat('c',64),'text','','bodyUnavailable',reason,'parts',jsonb_build_array(jsonb_build_object(
        'key','0.1','filename','Attachment.pdf','mime','application/pdf','size',9,'attachmentId','attachment-locator')))), 'unavailable','[]'::jsonb),
    'expires_at',now()+interval '1 hour'));
  update public.project_email_previews set confirmed_at=now(),selected_ids='["partial-m1"]' where id=preview;
  body_item:=jsonb_build_object('user_id',actor,'project_id',project,'account_id','partial-mailbox','message_id','partial-m1',
    'thread_id','partial-t1','part_key','body','filename','Email-partial-m1.docx');
  body_claim:=public.claim_project_email_item(body_item,body_lease);
  -- Same guarded transition as persistItem's authored exclusion branch; no
  -- byte staging, upload or document commit is attempted for this body.
  update public.project_email_items set status='excluded',detail=reason,lease_id=null,lease_until=null
    where id=(body_claim->>'id')::uuid and lease_id=body_lease and status='processing';
  get diagnostics rows_changed=row_count;
  perform pg_temp.assert_true(rows_changed=1,'partial body exclusion owns its processing lease');
  select to_jsonb(item) into body_terminal from public.project_email_items item where id=(body_claim->>'id')::uuid;
  perform pg_temp.assert_true(body_terminal->>'status'='excluded' and body_terminal->>'detail'=reason,
    'body exclusion and authored explanation are durable receipt facts');
  perform pg_temp.assert_true(not exists(select 1 from public.documents where project_id=project),
    'excluded body creates no project document');
  perform pg_temp.assert_true(not exists(select 1 from public.document_versions where id=(body_claim->>'version_id')::uuid
    or document_id=(body_claim->>'reserved_document_id')::uuid),'excluded body creates no document version');
  perform pg_temp.assert_true(not exists(select 1 from public.document_version_texts where version_id=(body_claim->>'version_id')::uuid)
    and not exists(select 1 from public.db_jobs where kind='document.extract_text' and payload->>'versionId'=body_claim->>'version_id'),
    'excluded body creates neither extraction cache nor extraction job');
  attachment_item:=body_item||jsonb_build_object('part_key','0.1','filename','Attachment.pdf');
  attachment_claim:=public.claim_project_email_item(attachment_item,attachment_lease);
  again:=public.claim_project_email_item(attachment_item,gen_random_uuid());
  perform pg_temp.assert_true(again->>'id'=attachment_claim->>'id' and again->>'lease_id'=attachment_lease::text,
    'rival cannot steal the supported attachment processing lease');
  perform pg_temp.assert_true(public.stage_project_email_item((attachment_claim->>'id')::uuid,attachment_lease,'synthetic/partial-attachment.pdf'),
    'supported attachment stages with its current lease');
  v:=jsonb_build_object('filename','Attachment.pdf','file_type','pdf','storage_path','synthetic/partial-attachment.pdf',
    'pdf_storage_path','synthetic/partial-attachment.pdf','content_sha256',encode(sha256(convert_to('%PDF-test','UTF8')),'hex'),'size_bytes',9);
  committed:=public.commit_project_email_document((attachment_claim->>'id')::uuid,attachment_lease,preview,v);
  perform pg_temp.assert_true(committed->>'status'='imported' and committed->>'import_preview_id'=preview::text
    and exists(select 1 from public.documents document join public.document_versions version on version.id=document.current_version_id
      where document.id=(committed->>'document_id')::uuid and document.project_id=project
        and version.id=(attachment_claim->>'version_id')::uuid and version.content_sha256=v->>'content_sha256'),
    'attachment identity, committed native version and preview provenance are retained');
  perform pg_temp.assert_true((select count(*)=1 from public.db_jobs where kind='document.extract_text'
    and payload->>'versionId'=attachment_claim->>'version_id'),'attachment commit has the normal extraction job');
  perform pg_temp.assert_true((select count(*)=2 from public.project_email_items where user_id=actor and project_id=project
    and account_id='partial-mailbox' and message_id='partial-m1')
    and exists(select 1 from public.project_email_items where id=(body_claim->>'id')::uuid and status='excluded' and detail=reason and document_id is null)
    and exists(select 1 from public.project_email_items where id=(attachment_claim->>'id')::uuid and status='imported'
      and document_id=(committed->>'document_id')::uuid and version_id=(committed->>'version_id')::uuid),
    'per-item receipt ledger preserves body exclusion alongside attachment identity');
  for retry in 1..3 loop
    again:=public.claim_project_email_item(body_item,gen_random_uuid());
    perform pg_temp.assert_true(again=body_terminal,'repeat body claim preserves its entire terminal exclusion identity');
    again:=public.claim_project_email_item(attachment_item,gen_random_uuid());
    perform pg_temp.assert_true(again=committed,'repeat attachment claim preserves its entire committed identity');
  end loop;
  perform pg_temp.assert_true(not public.stage_project_email_item((body_claim->>'id')::uuid,body_lease,'synthetic/resurrected-body.docx'),
    'former body lease cannot stage excluded content on retry');
  begin
    perform public.commit_project_email_document((body_claim->>'id')::uuid,body_lease,preview,
      v||'{"filename":"Email-partial-m1.docx","file_type":"docx","storage_path":"synthetic/resurrected-body.docx"}');
    raise exception 'excluded body unexpectedly resurrected';
  exception when raise_exception then if sqlerrm<>'email_intake_lease_lost' then raise;end if;end;
  perform pg_temp.assert_true((select count(*)=1 from public.documents where project_id=project)
    and (select count(*)=1 from public.document_versions version join public.documents document on document.id=version.document_id where document.project_id=project),
    'partial retries leave exactly one attachment document and one version');
  perform pg_temp.assert_true(not exists(select 1 from public.document_version_texts where version_id=(body_claim->>'version_id')::uuid)
    and not exists(select 1 from public.db_jobs where kind='document.extract_text' and payload->>'versionId'=body_claim->>'version_id'),
    'retries never resurrect body extraction work');
  raise notice 'partial receipt: body excluded, attachment imported; three retries retain one document/version and no body extraction';
end $$;
-- Review markers reuse the private item ledger without becoming source items.
-- Exercise the claim/failure flow used by the service; generic service-only
-- staging/commit RPCs are deliberately never invoked for reserved marker keys.
do $$
declare
  p_actor uuid;p_project uuid;p_account text;p_message text:='partial-m1';p_preview uuid;
  other_actor uuid:=gen_random_uuid();other_project uuid:=gen_random_uuid();other_preview uuid:=gen_random_uuid();fresh_preview uuid:=gen_random_uuid();
  lease_a uuid:=gen_random_uuid();lease_b uuid:=gen_random_uuid();lease_c uuid:=gen_random_uuid();
  marker_key text;marker_item jsonb;marker jsonb;identity jsonb;again jsonb;variant jsonb;separate jsonb;
  source_rows jsonb;imported jsonb;resources bigint[];rows_changed integer;
  reason text:='Message availability or import consent changed. Create a fresh preview; this confirmation will not import further content from this message.';
begin
  -- Reuse the actual committed/excluded partial-source rows above rather than
  -- fabricate terminal source states for the marker-preservation assertions.
  select user_id,project_id,account_id,id into strict p_actor,p_project,p_account,p_preview
    from public.project_email_previews where query='subject:synthetic-partial';
  select jsonb_agg(to_jsonb(item) order by item.id) into source_rows from public.project_email_items item
    where user_id=p_actor and project_id=p_project and account_id=p_account and message_id=p_message;
  perform pg_temp.assert_true(jsonb_array_length(source_rows)=2
    and exists(select 1 from jsonb_array_elements(source_rows) item where item->>'status'='excluded')
    and exists(select 1 from jsonb_array_elements(source_rows) item where item->>'status'='imported'),
    'marker fixture begins with real excluded and committed source receipts');
  insert into auth.users(id,email) values(other_actor,'marker-identity@example.invalid');
  insert into public.projects(id,user_id,name) values(other_project,other_actor,'Synthetic marker identity');
  select array[(select count(*) from public.documents),(select count(*) from public.document_versions),
    (select count(*) from public.document_version_texts),(select count(*) from public.db_jobs)] into resources;
  marker_key:='review:'||p_preview::text;
  marker_item:=jsonb_build_object('user_id',p_actor,'project_id',p_project,'account_id',p_account,'message_id',p_message,
    'thread_id','partial-t1','part_key',marker_key,'filename','Message consent review');
  separate:=public.claim_project_email_item(marker_item||jsonb_build_object('part_key','review:'||other_preview::text),gen_random_uuid());
  perform pg_temp.assert_true(not exists(select 1 from public.project_email_items where user_id=p_actor and project_id=p_project
    and account_id=p_account and message_id=p_message and part_key=marker_key),
    'a different preview marker does not falsely invalidate the current preview');
  marker:=public.claim_project_email_item(marker_item,lease_a);
  identity:=marker-'status'-'lease_id'-'lease_until'-'detail';
  perform pg_temp.assert_true(marker->>'status'='processing' and marker->>'id'<>separate->>'id',
    'current preview receives its own durable processing marker identity');
  again:=public.claim_project_email_item(marker_item,lease_b);
  perform pg_temp.assert_true(again=marker,'rival marker claim cannot steal a live lease');
  update public.project_email_items set status='failed',detail=reason,lease_id=null,lease_until=null
    where id=(marker->>'id')::uuid and lease_id=lease_b and status='processing';
  get diagnostics rows_changed=row_count;
  perform pg_temp.assert_true(rows_changed=0 and exists(select 1 from public.project_email_items where id=(marker->>'id')::uuid
    and part_key=marker_key and status='processing' and lease_id=lease_a),
    'failed stale-owner status write leaves the processing marker present');
  update public.project_email_items set status='failed',detail=reason,lease_id=null,lease_until=null
    where id=(marker->>'id')::uuid and lease_id=lease_a and status='processing';
  get diagnostics rows_changed=row_count;
  perform pg_temp.assert_true(rows_changed=1 and exists(select 1 from public.project_email_items where id=(marker->>'id')::uuid
    and part_key=marker_key and status='failed' and detail=reason),'owned failure persists the static fresh-preview marker');
  again:=public.claim_project_email_item(marker_item,lease_b);
  perform pg_temp.assert_true(again-'status'-'lease_id'-'lease_until'-'detail'=identity
    and again->>'status'='processing' and again->>'lease_id'=lease_b::text and again->>'detail' is null,
    'retry may clear failed detail and reacquire processing without clearing marker presence or identity');
  update public.project_email_items set lease_until=now()-interval '1 second' where id=(marker->>'id')::uuid and lease_id=lease_b;
  again:=public.claim_project_email_item(marker_item,lease_c);
  perform pg_temp.assert_true(again-'status'-'lease_id'-'lease_until'-'detail'=identity and again->>'lease_id'=lease_c::text,
    'expired processing marker is reclaimed under the same identity');
  update public.project_email_items set status='failed',detail=reason,lease_id=null,lease_until=null
    where id=(marker->>'id')::uuid and lease_id=lease_b and status='processing';
  get diagnostics rows_changed=row_count;
  perform pg_temp.assert_true(rows_changed=0,'expired marker owner cannot overwrite a newer lease');
  update public.project_email_items set status='failed',detail=reason,lease_id=null,lease_until=null
    where id=(marker->>'id')::uuid and lease_id=lease_c and status='processing';
  get diagnostics rows_changed=row_count;
  perform pg_temp.assert_true(rows_changed=1,'current marker owner may record the persistent failure');
  -- These are ledger-identity checks, not additional authorization grants.
  for variant in select value from jsonb_array_elements(jsonb_build_array(
    marker_item||jsonb_build_object('user_id',other_actor),marker_item||jsonb_build_object('project_id',other_project),
    marker_item||jsonb_build_object('account_id','different-marker-account'),marker_item||jsonb_build_object('message_id','different-message'))) loop
    perform pg_temp.assert_true(not exists(select 1 from public.project_email_items
      where user_id=(variant->>'user_id')::uuid and project_id=(variant->>'project_id')::uuid
        and account_id=variant->>'account_id' and message_id=variant->>'message_id' and part_key=marker_key),
      'an actor/project/account/message identity does not inherit a foreign marker');
    separate:=public.claim_project_email_item(variant,gen_random_uuid());
    perform pg_temp.assert_true(separate->>'id'<>marker->>'id','separate marker tuple cannot overwrite the original marker identity');
  end loop;
  perform pg_temp.assert_true((select count(*)=1 from public.project_email_items where user_id=p_actor and project_id=p_project
    and account_id=p_account and message_id=p_message and part_key=marker_key)
    and not exists(select 1 from public.project_email_items where user_id=p_actor and project_id=p_project
      and account_id=p_account and message_id=p_message and part_key='review:'||fresh_preview::text),
    'exact current-preview lookup finds one marker and a fresh preview has no inherited marker');
  perform pg_temp.assert_true((select jsonb_agg(to_jsonb(item) order by item.id) from public.project_email_items item
    where user_id=p_actor and project_id=p_project and account_id=p_account and message_id=p_message and part_key not like 'review:%')=source_rows,
    'marker failure/reclaim/identity operations leave every native terminal source row field-for-field unchanged');
  perform pg_temp.assert_true(resources=array[(select count(*) from public.documents),(select count(*) from public.document_versions),
    (select count(*) from public.document_version_texts),(select count(*) from public.db_jobs)],
    'marker claim/failure/reclaim creates no document, version, extraction row or job');
  perform pg_temp.assert_true(not exists(select 1 from public.project_email_items item where part_key like 'review:%' and (
    document_id is not null or storage_path is not null or content_sha256 is not null or imported_at is not null or import_preview_id is not null
    or cardinality(staged_paths)<>0 or filename<>'Message consent review'
    or exists(select 1 from public.documents d where d.id=item.reserved_document_id)
    or exists(select 1 from public.document_versions v where v.id=item.version_id)
    or exists(select 1 from public.document_version_texts t where t.version_id=item.version_id))),
    'reserved marker identities contain no staged paths, source content or document artifacts');
  select value into strict imported from jsonb_array_elements(source_rows) where value->>'status'='imported';
  delete from public.documents where id=(imported->>'document_id')::uuid;
  select array[(select count(*) from public.documents),(select count(*) from public.document_versions),
    (select count(*) from public.document_version_texts),(select count(*) from public.db_jobs)] into resources;
  again:=public.claim_project_email_item(marker_item,gen_random_uuid());
  perform pg_temp.assert_true(again-'status'-'lease_id'-'lease_until'-'detail'=identity,
    'marker presence and identity survive a source becoming a deletion tombstone');
  for variant in select value from jsonb_array_elements(source_rows) loop
    again:=public.claim_project_email_item(variant,gen_random_uuid());
    perform pg_temp.assert_true(again=variant,'marker retries preserve native exclusion and imported-tombstone receipts exactly');
  end loop;
  perform pg_temp.assert_true(not exists(select 1 from public.documents where project_id=p_project)
    and not exists(select 1 from public.document_versions v join public.project_email_items item on item.version_id=v.id
      where item.user_id=p_actor and item.project_id=p_project),
    'marker and native terminal retries cannot resurrect deleted source documents or versions');
  perform pg_temp.assert_true(resources=array[(select count(*) from public.documents),(select count(*) from public.document_versions),
    (select count(*) from public.document_version_texts),(select count(*) from public.db_jobs)],
    'post-deletion marker/source retries create no source artifacts or jobs');
  raise notice 'review marker: processing/failed/reclaimed identity persists; native terminal rows unchanged, no marker artifacts or cross-preview flags';
end $$;
rollback;
