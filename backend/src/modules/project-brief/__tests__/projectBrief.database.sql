-- Actual PostgreSQL test against a disposable local backend/schema.sql.
-- Entirely fictional data. This test never revokes an existing permission.
begin;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception '%',m;end if;end $$;
create function pg_temp.make_doc(p uuid,a uuid,body text,kind text default 'docx') returns uuid language plpgsql as $$
declare d uuid:=gen_random_uuid();v uuid:=gen_random_uuid();h text:=encode(sha256(convert_to(body,'UTF8')),'hex');r uuid;
begin
 insert into public.documents(id,project_id,user_id,status) values(d,p,a,'ready');
 perform public.create_document_version(d,jsonb_build_object('id',v,'storage_path','fictional/'||v,'filename','Fictional.'||kind,'file_type',kind,'size_bytes',length(body),'content_sha256',h,'source','upload'),true);
 select text_revision into r from public.document_versions where id=v;
 insert into public.document_version_texts(version_id,source_revision,status,text_content,source_sha256,textless_page_count)
 values(v,r,'ready',body,h,0) on conflict(version_id) do update set source_revision=excluded.source_revision,status='ready',text_content=excluded.text_content,source_sha256=excluded.source_sha256,textless_page_count=0;
 return d;
end $$;
create function pg_temp.make_proposal(p uuid,a uuid,b uuid,s uuid) returns uuid language plpgsql as $$
declare q uuid:=gen_random_uuid();
begin
 perform public.project_brief_save_proposal(p,a,'owner@example.invalid',jsonb_build_object('id',q,'designationId',public.project_brief_bundle(p,a,'owner@example.invalid')->>'designationId','base',public.project_brief_source(b),'sources',jsonb_build_array(public.project_brief_source(s)),
 'content','{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb,'before','Fictional previous brief','gaps','[]'::jsonb,
 'stagedVersion',jsonb_build_object('id',gen_random_uuid(),'storage_path','fictional/proposal/'||q,'filename','Brief.docx','file_type','docx','size_bytes',100,'content_sha256',repeat('a',64),'source','assistant_edit')));
 return q;
end $$;
do $$
declare a uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();b uuid;s uuid;scan uuid;q uuid;rival uuid;v uuid;outcome jsonb;old jsonb;mode text; n integer; expected jsonb;
begin
 insert into auth.users(id,email) values(a,'owner@example.invalid'),(outsider,'outsider@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional reviewed matter'),(p2,outsider,'Other fictional project');
 b:=pg_temp.make_doc(p,a,'Existing contested delivery position.');s:=pg_temp.make_doc(p,a,'Supplier alleges delivery May 12; buyer disputes acceptance.');scan:=pg_temp.make_doc(p,a,'Scanned source');
 update public.document_version_texts set status='failed',text_content=null where version_id=(select current_version_id from public.documents where id=scan);
 perform public.project_brief_designate(p,a,'owner@example.invalid',b);
 perform public.project_brief_designate(p,a,'owner@example.invalid',b);
 perform pg_temp.assert_true((select count(*)=1 from public.project_reviewed_briefs where project_id=p),'designation idempotent');
 begin
  perform public.project_brief_designate(p,a,'owner@example.invalid',pg_temp.make_doc(p,a,'Other live DOCX'));
  raise exception 'live designated brief unexpectedly replaced';
 exception when sqlstate 'PB002' then null;end;
 begin perform public.project_brief_bundle(p,outsider,'outsider@example.invalid');raise exception 'foreign access unexpectedly allowed';exception when no_data_found then null;end;
 begin perform public.project_brief_bundle(p,a,'owner@example.invalid',array[pg_temp.make_doc(p2,outsider,'Other private source')]);raise exception 'foreign selection unexpectedly allowed';exception when no_data_found then null;end;
 q:=pg_temp.make_proposal(p,a,b,s);rival:=pg_temp.make_proposal(p,a,b,s);
 perform pg_temp.assert_true((select count(*)=0 from public.project_brief_reviews where project_id=p),'proposal creation is not review');
 perform pg_temp.assert_true(public.project_brief_bundle(p,a,'owner@example.invalid')->>'pendingProposalId' is not null,'current proposal available after reload');
 perform pg_temp.assert_true((select count(*)=1 from public.document_versions where document_id=b),'proposal creation is not a new version');
 begin perform public.project_brief_apply(p,outsider,'outsider@example.invalid',q);raise exception 'unauthorized commit unexpectedly allowed';exception when no_data_found then null;end;
 outcome:=public.project_brief_apply(p,a,'owner@example.invalid',q);v:=(outcome->>'versionId')::uuid;
 perform pg_temp.assert_true((select current_version_id=v from public.documents where id=b),'Apply activates exact staged version');
 perform pg_temp.assert_true((select count(*)=1 from public.project_brief_reviews where project_id=p),'Apply records only readable selected source');
 perform pg_temp.assert_true((select not (public.project_brief_source(scan)->>'ready')::boolean),'unreadable remains outstanding');
 perform pg_temp.assert_true((public.project_brief_apply(p,a,'owner@example.invalid',q)->>'replayed')::boolean,'Apply retry idempotent');
 perform pg_temp.assert_true((select count(*)=2 from public.document_versions where document_id=b),'replay creates no extra version');
 begin perform public.project_brief_apply(p,a,'owner@example.invalid',rival);raise exception 'competing stale proposal unexpectedly allowed';exception when sqlstate 'PB001' then null;end;
 perform pg_temp.assert_true((select count(*)=1 from public.project_brief_reviews where project_id=p),'loser cannot advance checkpoint');
 perform pg_temp.assert_true(public.project_brief_bundle(p,a,'owner@example.invalid')->>'pendingProposalId' is null,'superseded proposal not restored over accepted brief');
 -- Make the newly accepted brief readable, as the normal extraction worker does.
 update public.document_version_texts set status='ready',text_content='Accepted position',source_sha256=repeat('a',64),textless_page_count=0 where version_id=v;
 -- Exercise mutations independently; the enclosing savepoint deliberately rolls
 -- each fictional mutation back. No project permissions are modified.
 foreach mode in array array['brief_bytes','source_bytes','source_cache','source_delete','source_move','empty','partial','rollback'] loop
  begin
   q:=pg_temp.make_proposal(p,a,b,s);
   old:=public.project_brief_source(b);
   if mode='brief_bytes' then update public.document_versions set storage_path=storage_path||'/changed',content_sha256=repeat('b',64) where id=v;
   elsif mode='source_bytes' then update public.document_versions set content_sha256=repeat('c',64) where id=(select current_version_id from public.documents where id=s);
   elsif mode='source_cache' then update public.document_version_texts set text_content='Different extraction under same revision' where version_id=(select current_version_id from public.documents where id=s);
   elsif mode='source_delete' then delete from public.documents where id=s;
   elsif mode='source_move' then update public.documents set project_id=p2 where id=s;
   elsif mode='empty' then update public.document_version_texts set text_content='' where version_id=(select current_version_id from public.documents where id=s);
   elsif mode='partial' then update public.document_version_texts set textless_page_count=1 where version_id=(select current_version_id from public.documents where id=s);
   elsif mode='rollback' then update public.project_brief_proposals set staged_version=jsonb_set(staged_version,'{size_bytes}','"bad"') where id=q;
   end if;
   begin
    perform public.project_brief_apply(p,a,'owner@example.invalid',q);
    raise exception 'invalidated proposal unexpectedly applied: %',mode;
   exception when sqlstate 'PB001' or invalid_text_representation then null;end;
   perform pg_temp.assert_true((select count(*)=1 from public.project_brief_reviews where project_id=p),'failed Apply does not advance ledger: '||mode);
   if mode<>'brief_bytes' then perform pg_temp.assert_true(public.project_brief_source(b)=old,'failed Apply preserves brief: '||mode);end if;
   raise sqlstate 'ZX001';
  exception when sqlstate 'ZX001' then null;
  end;
 end loop;
 -- A moved designated brief cannot leak its new project's current metadata.
 begin
  update public.documents set project_id=p2 where id=b;
  perform pg_temp.assert_true(public.project_brief_bundle(p,a,'owner@example.invalid')->'brief'='null'::jsonb,'moved brief hidden from former project');
  perform pg_temp.assert_true(public.project_brief_bundle(p,a,'owner@example.invalid')->'accepted'='null'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedContent'='null'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedAt'='null'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedEvidence'='[]'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->>'pendingProposalId' is null,'raw bundle cannot disclose accepted body or evidence after base moves out');
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(public.project_brief_bundle(p,a,'owner@example.invalid')->'sources') x where (x->>'reviewed')::boolean),'unavailable base has no active reviewed stamps');
  update public.documents set project_id=p where id=b;
  perform pg_temp.assert_true(public.project_brief_bundle(p,a,'owner@example.invalid')->'accepted' is distinct from 'null'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedContent' is distinct from 'null'::jsonb
    and public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedAt' is distinct from 'null'::jsonb
    and jsonb_array_length(public.project_brief_bundle(p,a,'owner@example.invalid')->'acceptedEvidence')>0,'unchanged base returning to same designation restores authorized accepted state');
  perform pg_temp.assert_true(exists(select 1 from jsonb_array_elements(public.project_brief_bundle(p,a,'owner@example.invalid')->'sources') x where (x->>'reviewed')::boolean),'unchanged returning base restores existing review stamps');
  update public.documents set project_id=p2 where id=b;
  -- Destination designation must work BEFORE the former project replaces its brief.
  perform public.project_brief_designate(p2,outsider,'outsider@example.invalid',b);
  perform pg_temp.assert_true((select accepted_snapshot is null from public.project_reviewed_briefs where project_id=p2),'destination does not inherit former project review stamp');
  perform pg_temp.assert_true(public.project_brief_bundle(p2,outsider,'outsider@example.invalid')->'acceptedEvidence'='[]'::jsonb,'destination sees no former project evidence ledger');
  perform public.project_brief_designate(p,a,'owner@example.invalid',pg_temp.make_doc(p,a,'Replacement brief'));
  perform pg_temp.assert_true((select accepted_snapshot is null from public.project_reviewed_briefs where project_id=p),'replacement does not inherit accepted stamp');
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(public.project_brief_bundle(p,a,'owner@example.invalid')->'sources') x where (x->>'reviewed')::boolean),'replacement does not inherit prior source-review stamp');
  raise sqlstate 'ZX001';
 exception when sqlstate 'ZX001' then null;
 end;
 expected:=public.project_brief_source(s);
 update public.document_versions set filename='Renamed.docx' where id=(select current_version_id from public.documents where id=s);
 perform pg_temp.assert_true(not exists(select 1 from public.project_brief_reviews where project_id=p and source=public.project_brief_source(s)),'changed source identity is not silently reviewed');
 perform pg_temp.assert_true((select count(*)=2 from public.document_versions where document_id=b),'prior brief version retained');
 perform pg_temp.assert_true(not has_table_privilege('authenticated','public.project_brief_proposals','SELECT'),'private proposals not directly enumerable');
 perform pg_temp.assert_true(not has_function_privilege('authenticated','public.project_brief_apply(uuid,uuid,text,uuid)','EXECUTE'),'browser cannot bypass human Apply route');
end $$;
-- Designation history must not follow a returning document into a fresh binding.
do $$
declare a uuid:=gen_random_uuid();p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();
  b uuid;b2 uuid;s uuid;q uuid;stale uuid;accepted_version uuid;epoch text;replacement_epoch text;
  captured jsonb;state jsonb;outcome jsonb;
begin
 insert into auth.users(id,email) values(a,'designation-test@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional designation history'),(p2,a,'Fictional temporary project');
 b:=pg_temp.make_doc(p,a,'Existing brief.');s:=pg_temp.make_doc(p,a,'Source evidence.');
 perform public.project_brief_designate(p,a,'designation-test@example.invalid',b);
 epoch:=public.project_brief_bundle(p,a,'designation-test@example.invalid')->>'designationId';
 q:=pg_temp.make_proposal(p,a,b,s);
 outcome:=public.project_brief_apply(p,a,'designation-test@example.invalid',q);
 accepted_version:=(outcome->>'versionId')::uuid;
 update public.document_version_texts set status='ready',text_content='Accepted position',source_sha256=repeat('a',64),textless_page_count=0 where version_id=accepted_version;
 stale:=pg_temp.make_proposal(p,a,b,s);
 -- This payload represents generation already in flight at the original epoch.
 select jsonb_build_object('id',gen_random_uuid(),'designationId',epoch,'base',base,'sources',sources,
   'content',content,'before',before_text,'gaps',gaps,'stagedVersion',staged_version)
   into captured from public.project_brief_proposals where id=stale;
 update public.documents set project_id=p2 where id=b;
 b2:=pg_temp.make_doc(p,a,'Replacement brief');
 perform public.project_brief_designate(p,a,'designation-test@example.invalid',b2);
 replacement_epoch:=public.project_brief_bundle(p,a,'designation-test@example.invalid')->>'designationId';
 update public.documents set project_id=p2 where id=b2;
 update public.documents set project_id=p where id=b;
 perform public.project_brief_designate(p,a,'designation-test@example.invalid',b);
 state:=public.project_brief_bundle(p,a,'designation-test@example.invalid');
 perform pg_temp.assert_true(state->'accepted'='null'::jsonb and state->'acceptedAt'='null'::jsonb,'returning document begins without accepted position');
 perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(state->'sources') x where (x->>'reviewed')::boolean),'returning designated document cannot revive old reviewed stamps');
 perform pg_temp.assert_true(epoch is not null and replacement_epoch<>epoch and state->>'designationId'<>replacement_epoch and state->>'designationId'<>epoch,'each replacement has a distinct designation generation');
 perform public.project_brief_designate(p,a,'designation-test@example.invalid',b);
 perform pg_temp.assert_true(public.project_brief_bundle(p,a,'designation-test@example.invalid')->>'designationId'=state->>'designationId','same active designation preserves generation');
 perform pg_temp.assert_true(state->>'pendingProposalId' is null,'returning designation hides old pending proposal');
 begin
  perform public.project_brief_apply(p,a,'designation-test@example.invalid',stale);
  raise exception 'old-generation proposal unexpectedly applied';
 exception when sqlstate 'PB001' then null;end;
 begin
  perform public.project_brief_save_proposal(p,a,'designation-test@example.invalid',captured);
  raise exception 'old-generation in-flight proposal unexpectedly saved';
 exception when sqlstate 'PB001' then null;end;
 begin
  perform public.project_brief_save_proposal(p,a,'designation-test@example.invalid',captured-'designationId');
  raise exception 'proposal without generation unexpectedly saved';
 exception when sqlstate 'PB001' then null;end;
 outcome:=public.project_brief_apply(p,a,'designation-test@example.invalid',q);
 perform pg_temp.assert_true((outcome->>'replayed')::boolean and (outcome->>'versionId')::uuid=accepted_version,'old applied proposal retains historical replay');
 perform pg_temp.assert_true((select count(*)=2 from public.document_versions where document_id=b),'stale proposal and replay create no versions');
 perform pg_temp.assert_true((select count(*)=1 from public.project_brief_reviews where project_id=p),'historical review ledger retained');
 q:=pg_temp.make_proposal(p,a,b,s);
 update public.documents set project_id=p2 where id=s;
 perform pg_temp.assert_true(public.project_brief_bundle(p,a,'designation-test@example.invalid')->>'pendingProposalId' is null,'moved source is not resumable pending work');
 begin
  perform public.project_brief_apply(p,a,'designation-test@example.invalid',q);
  raise exception 'moved-source proposal unexpectedly applied';
 exception when sqlstate 'PB001' then null;end;
 -- Identical evidence returning to the same designation may revalidate.
 update public.documents set project_id=p where id=s;
 perform pg_temp.assert_true(public.project_brief_bundle(p,a,'designation-test@example.invalid')->>'pendingProposalId'=q::text,'unchanged source returning to same designation may resume');
 perform public.project_brief_apply(p,a,'designation-test@example.invalid',q);
end $$;
-- Physical deletion retains audit identities, but scrubs copied text for every deleted base.
do $$
declare a uuid:=gen_random_uuid();p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();
  b uuid;b2 uuid;b3 uuid;source_doc uuid;q uuid;q2 uuid;q3 uuid;pending uuid;v uuid;first_version uuid;epoch text;state jsonb;outcome jsonb;first_metadata jsonb;second_metadata jsonb;pending_metadata jsonb;third_snapshot jsonb;
begin
 insert into auth.users(id,email) values(a,'deletion-test@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional retained review metadata'),(p2,a,'Fictional prior brief location');
 b:=pg_temp.make_doc(p,a,'First brief');source_doc:=pg_temp.make_doc(p,a,'Source evidence');
 perform public.project_brief_designate(p,a,'deletion-test@example.invalid',b);
 q:=pg_temp.make_proposal(p,a,b,source_doc);
 update public.project_brief_proposals set before_text='First private base text',
   content='{"position":[{"text":"First proposed statement","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',
   gaps='[{"filename":"Private context filename","reason":"Not selected"}]' where id=q;
 first_version:=(public.project_brief_apply(p,a,'deletion-test@example.invalid',q)->>'versionId')::uuid;
 update public.documents set project_id=p2 where id=b;
 b2:=pg_temp.make_doc(p,a,'Replacement brief');
 perform public.project_brief_designate(p,a,'deletion-test@example.invalid',b2);
 q2:=pg_temp.make_proposal(p,a,b2,source_doc);
 update public.project_brief_proposals set before_text='Replacement private base text',
   content='{"position":[{"text":"Replacement proposed statement","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',
   gaps='[{"filename":"Replacement context filename","reason":"Not selected"}]' where id=q2;
 v:=(public.project_brief_apply(p,a,'deletion-test@example.invalid',q2)->>'versionId')::uuid;
 update public.document_version_texts set status='ready',text_content='Accepted replacement',source_sha256=repeat('a',64),textless_page_count=0 where version_id=v;
 pending:=pg_temp.make_proposal(p,a,b2,source_doc);
 update public.project_brief_proposals set before_text='Pending private base text',
   content='{"position":[{"text":"Pending proposed statement","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',
   gaps='[{"filename":"Pending context filename","reason":"Not selected"}]' where id=pending;
 select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id' into first_metadata from public.project_brief_proposals proposal where id=q;
 select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id' into second_metadata from public.project_brief_proposals proposal where id=q2;
 select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id' into pending_metadata from public.project_brief_proposals proposal where id=pending;
 epoch:=public.project_brief_bundle(p,a,'deletion-test@example.invalid')->>'designationId';
 -- This is the normal documents.shared delete operation, not version soft delete.
 delete from public.documents where id=b2;
 perform pg_temp.assert_true((select count(*)=1 from public.project_reviewed_briefs where project_id=p),'project binding survives designated document deletion');
 perform pg_temp.assert_true((select count(*)=3 from public.project_brief_proposals where project_id=p),'all designation proposal history survives current brief deletion');
 perform pg_temp.assert_true((select count(*)=2 from public.project_brief_reviews where project_id=p),'all review metadata survives current brief deletion');
 perform pg_temp.assert_true((select bool_and(before_text='' and content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb and gaps='[]'::jsonb) from public.project_brief_proposals where id in(q2,pending)),'deleted current base scrubs applied and pending copied text and gaps');
 perform pg_temp.assert_true((select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id'=second_metadata from public.project_brief_proposals proposal where id=q2) and (select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id'=pending_metadata from public.project_brief_proposals proposal where id=pending),'deleted current-base applied/pending identities, timestamps and source fingerprints retained');
 perform pg_temp.assert_true((select before_text='First private base text' and jsonb_array_length(content->'position')=1 and jsonb_array_length(gaps)=1 from public.project_brief_proposals where id=q),'current base deletion leaves other-base proposal text intact');
 perform pg_temp.assert_true((select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id'=first_metadata from public.project_brief_proposals proposal where id=q),'other-base audit identities and fingerprints unchanged');
 state:=public.project_brief_bundle(p,a,'deletion-test@example.invalid');
 perform pg_temp.assert_true((select document_id is null from public.project_reviewed_briefs where project_id=p),'deleted brief is detached');
 perform pg_temp.assert_true(state->>'designationId'<>epoch,'detachment rotates designation generation');
 perform pg_temp.assert_true(state->'brief'='null'::jsonb and state->'accepted'='null'::jsonb and state->'acceptedContent'='null'::jsonb and state->'acceptedAt'='null'::jsonb and state->>'pendingProposalId' is null,'detachment clears every active checkpoint field');
 perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(state->'sources') x where (x->>'reviewed')::boolean),'detachment cannot retain active reviewed stamps');
 begin
  perform public.project_brief_apply(p,a,'deletion-test@example.invalid',q2);
  raise exception 'deleted applied version unexpectedly replayed';
 exception when no_data_found then null;end;
 outcome:=public.project_brief_apply(p,a,'deletion-test@example.invalid',q);
 perform pg_temp.assert_true((outcome->>'replayed')::boolean and (outcome->>'versionId')::uuid=first_version,'live historical applied version still replays');
 -- Soft deletion of a historical applied version also returns typed not-found.
 perform public.delete_document_version(b,first_version,a);
 begin
  perform public.project_brief_apply(p,a,'deletion-test@example.invalid',q);
  raise exception 'soft-deleted applied version unexpectedly replayed';
 exception when no_data_found then null;end;
 b3:=pg_temp.make_doc(p,a,'New brief after deletion');
 perform public.project_brief_designate(p,a,'deletion-test@example.invalid',b3);
 state:=public.project_brief_bundle(p,a,'deletion-test@example.invalid');
 perform pg_temp.assert_true(state->'brief'->>'documentId'=b3::text and state->'accepted'='null'::jsonb,'new designation after deletion starts fresh');
 perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(state->'sources') x where (x->>'reviewed')::boolean),'new designation cannot revive retained review stamps');
 q3:=pg_temp.make_proposal(p,a,b3,source_doc);
 update public.project_brief_proposals set before_text='Still-live third base text',
   content='{"position":[{"text":"Still-live proposed statement","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',
   gaps='[{"filename":"Still-live context filename","reason":"Not selected"}]' where id=q3;
 select to_jsonb(proposal) into third_snapshot from public.project_brief_proposals proposal where id=q3;
 delete from public.documents where id=b;
 perform pg_temp.assert_true((select before_text='' and content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb and gaps='[]'::jsonb from public.project_brief_proposals where id=q),'deleting former designated base also scrubs copied text and gaps');
 perform pg_temp.assert_true((select to_jsonb(proposal)-'before_text'-'content'-'gaps'-'applied_version_id'=first_metadata from public.project_brief_proposals proposal where id=q),'deleted former-base audit identities and source fingerprints retained');
 perform pg_temp.assert_true((select to_jsonb(proposal)=third_snapshot from public.project_brief_proposals proposal where id=q3),'former-base deletion leaves all still-live other-base proposal data intact');
 delete from public.documents where id=source_doc;
 perform pg_temp.assert_true((select count(*)=4 from public.project_brief_proposals where project_id=p) and (select count(*)=2 from public.project_brief_reviews where project_id=p),'ordinary source deletion also preserves proposal/review metadata');
 delete from public.projects where id=p;
 perform pg_temp.assert_true(not exists(select 1 from public.project_reviewed_briefs where project_id=p) and not exists(select 1 from public.project_brief_proposals where project_id=p) and not exists(select 1 from public.project_brief_reviews where project_id=p),'project deletion removes retained brief metadata');
end $$;
-- Version tombstones and physical deletes also remove copied brief text.
do $$
declare a uuid:=gen_random_uuid();p uuid:=gen_random_uuid();other_p uuid:=gen_random_uuid();b uuid;source_doc uuid;other_b uuid;other_source uuid;other_q uuid;other_content jsonb;
  initial_version uuid;accepted_version uuid;live_version uuid;physical_version uuid;
  q uuid;q2 uuid;live_q uuid;physical_q uuid;live_snapshot jsonb;state jsonb;
  empty_content jsonb:='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}';
begin
 insert into auth.users(id,email) values(a,'version-privacy-test@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional version privacy');
 b:=pg_temp.make_doc(p,a,'Original version text');source_doc:=pg_temp.make_doc(p,a,'Source evidence');
 select current_version_id into initial_version from public.documents where id=b;
 perform public.project_brief_designate(p,a,'version-privacy-test@example.invalid',b);
 q:=pg_temp.make_proposal(p,a,b,source_doc);
 update public.project_brief_proposals set before_text='Original version copied text',
   content='{"position":[{"text":"Original proposed text","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',gaps='[{"filename":"Original gap"}]' where id=q;
 accepted_version:=(public.project_brief_apply(p,a,'version-privacy-test@example.invalid',q)->>'versionId')::uuid;
 update public.document_version_texts set status='ready',text_content='Accepted output text',source_sha256=repeat('a',64),textless_page_count=0 where version_id=accepted_version;
 q2:=pg_temp.make_proposal(p,a,b,source_doc);
 update public.project_brief_proposals set before_text='Accepted version copied text',
   content='{"position":[{"text":"Pending proposed text","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',gaps='[{"filename":"Accepted gap"}]' where id=q2;
 live_version:=(public.create_document_version(b,jsonb_build_object('storage_path','fictional/live-version','filename','Live.docx','file_type','docx','size_bytes',100,'content_sha256',repeat('d',64),'source','assistant_edit'),true)->>'id')::uuid;
 update public.document_version_texts set status='ready',text_content='Still live current revision',source_sha256=repeat('d',64),textless_page_count=0 where version_id=live_version;
 live_q:=pg_temp.make_proposal(p,a,b,source_doc);
 update public.project_brief_proposals set before_text='Still live copied text',
   content='{"position":[{"text":"Still live pending text","status":"source_assertion","citations":[{"source":1,"quote":"Source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}',gaps='[{"filename":"Live gap"}]' where id=live_q;
 select to_jsonb(proposal) into live_snapshot from public.project_brief_proposals proposal where id=live_q;
 insert into public.projects(id,user_id,name) values(other_p,a,'Fictional unaffected checkpoint');
 other_b:=pg_temp.make_doc(other_p,a,'Other live brief');other_source:=pg_temp.make_doc(other_p,a,'Other source evidence');
 perform public.project_brief_designate(other_p,a,'version-privacy-test@example.invalid',other_b);
 other_q:=pg_temp.make_proposal(other_p,a,other_b,other_source);
 update public.project_brief_proposals set content='{"position":[{"text":"Other accepted text","status":"source_assertion","citations":[{"source":1,"quote":"Other source evidence"}]}],"awaiting":[],"uncertainties":[],"nextAction":[]}' where id=other_q;
 perform public.project_brief_apply(other_p,a,'version-privacy-test@example.invalid',other_q);
 select accepted_content into other_content from public.project_reviewed_briefs where project_id=other_p;
 perform public.delete_document_version(b,initial_version,a);
 perform pg_temp.assert_true((select before_text='' and content=empty_content and gaps='[]'::jsonb from public.project_brief_proposals where id=q),'base version tombstone scrubs copied proposal text');
 perform pg_temp.assert_true((select before_text='Accepted version copied text' from public.project_brief_proposals where id=q2),'base version tombstone leaves unrelated base proposal intact');
 perform pg_temp.assert_true((public.project_brief_apply(p,a,'version-privacy-test@example.invalid',q)->>'replayed')::boolean,'live output still replays after its deleted base text was scrubbed');
 perform public.delete_document_version(b,accepted_version,a);
 perform pg_temp.assert_true((select accepted_content is null from public.project_reviewed_briefs where project_id=p),'accepted output tombstone scrubs stored accepted-content duplicate');
 perform pg_temp.assert_true((select accepted_content=other_content from public.project_reviewed_briefs where project_id=other_p),'version tombstone preserves unrelated current checkpoint body');
 perform pg_temp.assert_true((select bool_and(before_text='' and content=empty_content and gaps='[]'::jsonb) from public.project_brief_proposals where id in(q,q2)),'accepted output tombstone scrubs output and dependent base proposal text');
 state:=public.project_brief_bundle(p,a,'version-privacy-test@example.invalid');
 perform pg_temp.assert_true(state->'brief'->>'versionId'=live_version::text and state->'accepted'='null'::jsonb and state->'acceptedContent'='null'::jsonb and state->'acceptedAt'='null'::jsonb and state->'acceptedEvidence'='[]'::jsonb,'deleted accepted version cannot leak cached body while another current brief version remains live');
 perform pg_temp.assert_true((select to_jsonb(proposal)=live_snapshot from public.project_brief_proposals proposal where id=live_q),'tombstones leave all still-live proposal data intact');
 physical_version:=(public.create_document_version(b,jsonb_build_object('storage_path','fictional/physical-version','filename','Physical.docx','file_type','docx','size_bytes',100,'content_sha256',repeat('e',64),'source','assistant_edit'),true)->>'id')::uuid;
 update public.document_version_texts set status='ready',text_content='Later deleted physical version',source_sha256=repeat('e',64),textless_page_count=0 where version_id=physical_version;
 physical_q:=pg_temp.make_proposal(p,a,b,source_doc);
 update public.project_brief_proposals set before_text='Physical version copied text',content=(select content from public.project_brief_proposals where id=live_q),gaps='[{"filename":"Physical gap"}]' where id=physical_q;
 update public.documents set current_version_id=live_version where id=b;
 delete from public.document_versions where id=physical_version;
 perform pg_temp.assert_true((select before_text='' and content=empty_content and gaps='[]'::jsonb from public.project_brief_proposals where id=physical_q),'physical base version deletion scrubs copied proposal text');
 delete from public.document_versions where id=accepted_version;
 perform pg_temp.assert_true((select applied_version_id is null from public.project_brief_proposals where id=q),'physical output deletion clears obsolete FK pointer safely');
 perform pg_temp.assert_true((select to_jsonb(proposal)=live_snapshot from public.project_brief_proposals proposal where id=live_q),'physical deletions leave unrelated current-base proposal intact');
 perform pg_temp.assert_true((select count(*)=4 from public.project_brief_proposals where project_id=p) and (select count(*)=1 from public.project_brief_reviews where project_id=p),'version deletions preserve proposal identities and review fingerprints');
end $$;
-- Crossing the proposal-size limit does not strand existing history or citations.
do $$
declare a uuid:=gen_random_uuid();p uuid:=gen_random_uuid();b uuid;source_doc uuid;q uuid;v uuid;captured jsonb;state jsonb;
begin
 insert into auth.users(id,email) values(a,'large-inventory-test@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional large inventory');
 b:=pg_temp.make_doc(p,a,'Brief');source_doc:=pg_temp.make_doc(p,a,'Source evidence');
 perform public.project_brief_designate(p,a,'large-inventory-test@example.invalid',b);
 q:=pg_temp.make_proposal(p,a,b,source_doc);
 v:=(public.project_brief_apply(p,a,'large-inventory-test@example.invalid',q)->>'versionId')::uuid;
 update public.document_version_texts set status='ready',text_content='Accepted brief',source_sha256=repeat('a',64),textless_page_count=0 where version_id=v;
 q:=pg_temp.make_proposal(p,a,b,source_doc);
 select jsonb_build_object('id',gen_random_uuid(),'designationId',designation_id,'base',base,'sources',sources,
   'content',content,'before',before_text,'gaps',gaps,'stagedVersion',staged_version)
   into captured from public.project_brief_proposals where id=q;
 insert into public.documents(project_id,user_id,status) select p,a,'ready' from generate_series(1,499);
 state:=public.project_brief_bundle(p,a,'large-inventory-test@example.invalid');
 perform pg_temp.assert_true(jsonb_array_length(state->'sources')=501 and state->'accepted'->>'versionId'=v::text,'accepted history and full inventory readable above proposal limit');
 perform pg_temp.assert_true(exists(select 1 from jsonb_array_elements(state->'sources') x where x->>'documentId'=source_doc::text),'citation membership gate remains readable above proposal limit');
 begin
  perform public.project_brief_bundle(p,a,'large-inventory-test@example.invalid',array[source_doc]);
  raise exception 'oversized proposal generation inventory unexpectedly accepted';
 exception when invalid_parameter_value then null;end;
 begin
  perform public.project_brief_save_proposal(p,a,'large-inventory-test@example.invalid',captured);
  raise exception 'oversized proposal save inventory unexpectedly accepted';
 exception when invalid_parameter_value then null;end;
 perform public.project_brief_apply(p,a,'large-inventory-test@example.invalid',q);
end $$;
-- Count actual calls in this disposable database, not an EXPLAIN estimate.
-- SQL functions with SET options are not inlined; track_functions=all also
-- includes them. This fixture runs as the disposable database's administrator.
set local track_functions='all';
do $$
declare a uuid:=gen_random_uuid();p uuid:=gen_random_uuid();b uuid;s uuid;q uuid;
  calls_before bigint;calls_after bigint;expected_calls bigint;source jsonb;bundle jsonb;
begin
 insert into auth.users(id,email) values(a,'snapshot-test@example.invalid');
 insert into public.projects(id,user_id,name) values(p,a,'Fictional snapshot diagnostics');
 b:=pg_temp.make_doc(p,a,'Existing brief.');s:=pg_temp.make_doc(p,a,'Source evidence.');
 perform public.project_brief_designate(p,a,'snapshot-test@example.invalid',b);
 q:=pg_temp.make_proposal(p,a,b,s);
 perform public.project_brief_apply(p,a,'snapshot-test@example.invalid',q);
 select count(*) into expected_calls from public.documents where project_id=p and archived_at is null;
 select coalesce(sum(calls),0) into calls_before from pg_stat_xact_user_functions
   where funcid='public.project_brief_source(uuid)'::regprocedure;
 bundle:=public.project_brief_bundle(p,a,'snapshot-test@example.invalid');
 select coalesce(sum(calls),0) into calls_after from pg_stat_xact_user_functions
   where funcid='public.project_brief_source(uuid)'::regprocedure;
 perform pg_temp.assert_true(calls_after-calls_before=expected_calls,
   format('one source snapshot per document: expected %s calls, received %s',expected_calls,calls_after-calls_before));
 raise notice 'snapshot calls per bundle: % for % documents',calls_after-calls_before,expected_calls;
 perform pg_temp.assert_true(jsonb_array_length(bundle->'sources')=expected_calls,'bundle retains all project sources');
 perform pg_temp.assert_true((select (x->>'reviewed')::boolean from jsonb_array_elements(bundle->'sources') x
   where x->>'documentId'=s::text),'reused snapshot preserves reviewed-source detection');
 begin
  update public.document_versions set storage_path=null where id=(select current_version_id from public.documents where id=s);
  source:=public.project_brief_source(s);
  perform pg_temp.assert_true(not (source->>'ready')::boolean and source->>'reason'='Stored file unavailable',
    'missing stored file has an explicit readiness reason');
  bundle:=public.project_brief_bundle(p,a,'snapshot-test@example.invalid');
  perform pg_temp.assert_true((select x->>'reason'='Stored file unavailable' from jsonb_array_elements(bundle->'sources') x
    where x->>'documentId'=s::text),'bundle preserves stored-file reason rather than an unselected fallback');
  raise sqlstate 'ZX001';
 exception when sqlstate 'ZX001' then null;end;
 begin
  update public.document_version_texts set extractor_version=2 where version_id=(select current_version_id from public.documents where id=s);
  source:=public.project_brief_source(s);
  perform pg_temp.assert_true(not (source->>'ready')::boolean and source->>'reason'='Extraction must be refreshed',
    'noncurrent extractor has an explicit readiness reason');
  bundle:=public.project_brief_bundle(p,a,'snapshot-test@example.invalid');
  perform pg_temp.assert_true((select x->>'reason'='Extraction must be refreshed' from jsonb_array_elements(bundle->'sources') x
    where x->>'documentId'=s::text),'bundle preserves extractor reason rather than an unselected fallback');
  raise sqlstate 'ZX001';
 exception when sqlstate 'ZX001' then null;end;
end $$;
rollback;
