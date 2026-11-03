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
 perform public.project_brief_save_proposal(p,a,'owner@example.invalid',jsonb_build_object('id',q,'base',public.project_brief_source(b),'sources',jsonb_build_array(public.project_brief_source(s)),
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
