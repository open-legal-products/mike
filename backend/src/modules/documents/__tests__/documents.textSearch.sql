-- Disposable local PostgreSQL only. Assertions and fixtures always roll back.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
do $$
declare
  owner_id uuid:=gen_random_uuid(); reader_id uuid:=gen_random_uuid();
  project uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  doc uuid:=gen_random_uuid(); template uuid:=gen_random_uuid(); library_doc uuid:=gen_random_uuid();
  v1 uuid; v2 uuid; tv uuid; lv uuid; revision uuid; old_revision uuid; r jsonb; match jsonb;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(reader_id,reader_id||'@example.test');
  insert into public.organizations(id,name,created_by,kind) values(org,'Search test',owner_id,'team');
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,reader_id,'member');
  insert into public.projects(id,org_id,user_id,name) values(project,org,owner_id,'Search matter');
  insert into public.documents(id,org_id,project_id,user_id,status) values(doc,org,project,owner_id,'ready');
  insert into public.documents(id,user_id,status,library_kind) values(template,owner_id,'ready','template'),(library_doc,owner_id,'ready','file');
  v1:=(public.create_document_version(doc,'{"filename":"agreement.docx","storage_path":"old.docx","file_type":"docx"}',true)->>'id')::uuid;
  select text_revision into revision from document_versions where id=v1;
  perform pg_temp.assert_true((select count(*)=1 from db_jobs where kind='document.extract_text' and payload->>'versionId'=v1::text),'upload atomically schedules extraction');
  perform public.publish_document_text(v1,revision,'Historical assignment clause','hash',0);
  v2:=(public.create_document_version(doc,'{"filename":"agreement.docx","storage_path":"new.docx","file_type":"docx"}',true)->>'id')::uuid;
  select text_revision into revision from document_versions where id=v2;
  r:=public.find_document_text(owner_id::text,'',org::text,'project','assignment',project);
  perform pg_temp.assert_true((r#>>'{coverage,pending_versions}')::int=1 and jsonb_array_length(r->'matches')=0,'pending active version does not expose old text');
  perform public.publish_document_text(v2,revision,'😀 Consent requires 100% consent and a_b. Assignment permitted.','hash',0);
  r:=public.find_document_text(owner_id::text,'',org::text,'project','ASSIGNMENT',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1 and r#>>'{matches,0,version_id}'=v2::text,'case insensitive current version search');
  match:=r#>'{matches,0}';
  perform pg_temp.assert_true(substring('😀 Consent requires 100% consent and a_b. Assignment permitted.' from (match->>'start_char')::int+1 for 10)='Assignment','Unicode offsets refer to original text');
  r:=public.find_document_text(owner_id::text,'',org::text,'document','Historical',null,doc,v1);
  perform pg_temp.assert_true(r#>>'{matches,0,version_id}'=v1::text,'historical version search is explicit');
  perform pg_temp.assert_true(public.read_document_text(owner_id::text,'',doc,v1)->>'text'='Historical assignment clause','historical read stays pinned');
  r:=public.find_document_text(owner_id::text,'','personal','project','Assignment',project);
  perform pg_temp.assert_true((r#>>'{coverage,total_versions}')::int=0,'workspace isolation covers counts');
  r:=public.find_document_text(reader_id::text,'',org::text,'project','Assignment',project);
  perform pg_temp.assert_true((r#>>'{coverage,total_versions}')::int=0,'private project hides text and counts');
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values(project,org,reader_id,'viewer');
  r:=public.find_document_text(reader_id::text,'',org::text,'project','Assignment',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1,'shared project viewer can find text');
  update project_org_access_overrides set role='deny' where project_id=project and user_id=reader_id;
  perform pg_temp.assert_true(public.read_document_text(reader_id::text,'',doc,v2) is null,'revocation between search and read denies content');
  r:=public.find_document_text(owner_id::text,'',org::text,'project','100%',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1,'percent is literal');
  r:=public.find_document_text(owner_id::text,'',org::text,'project','a_b',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1,'underscore is literal');
  r:=public.find_document_text(owner_id::text,'',org::text,'project','.*',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=0,'regex metacharacters are literal');
  old_revision:=revision;
  update document_versions set filename='renamed.docx',pdf_storage_path='rendition.pdf' where id=v2;
  perform pg_temp.assert_true((select text_revision=old_revision from document_versions where id=v2),'metadata/rendition changes preserve text');
  update document_versions set storage_path='edited.docx',content_sha256='new-hash' where id=v2;
  select text_revision into revision from document_versions where id=v2;
  perform pg_temp.assert_true(revision<>old_revision,'content edit creates a new revision');
  perform pg_temp.assert_true(not public.publish_document_text(v2,old_revision,'Obsolete assignment','hash',0),'late old writer cannot publish');
  perform pg_temp.assert_true((select text_content is null and status='pending' from document_version_texts where version_id=v2),'edit invalidates old text immediately');
  perform public.publish_document_text(v2,revision,'Updated consent','new-hash',0);
  r:=public.find_document_text(owner_id::text,'',org::text,'project','Assignment',project);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=0,'old text disappears after edit');
  perform pg_temp.assert_true(public.read_document_text(owner_id::text,'',doc,v1)->>'text'='Historical assignment clause','editing current preserves history');
  tv:=(public.create_document_version(template,'{"filename":"template.docx","storage_path":"template.docx","file_type":"docx"}',true)->>'id')::uuid;
  lv:=(public.create_document_version(library_doc,'{"filename":"file.pdf","storage_path":"file.pdf","file_type":"pdf"}',true)->>'id')::uuid;
  select text_revision into revision from document_versions where id=tv;
  perform public.publish_document_text(tv,revision,'Library consent','hash',0);
  select text_revision into revision from document_versions where id=lv;
  perform public.publish_document_text(lv,revision,'Library consent','hash',2);
  r:=public.find_document_text(owner_id::text,'','personal','templates','consent');
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1 and r#>>'{matches,0,document_id}'=template::text,'template scope is separate');
  r:=public.find_document_text(owner_id::text,'','personal','library','consent');
  perform pg_temp.assert_true(jsonb_array_length(r->'matches')=1 and (r#>>'{coverage,versions_needing_ocr}')::int=1,'library scope reports OCR gaps');
  r:=public.find_document_text(reader_id::text,'','personal','templates','consent');
  perform pg_temp.assert_true((r#>>'{coverage,total_versions}')::int=0,'another user cannot search library templates');
  perform pg_temp.assert_true(public.read_document_text(owner_id::text,'',template,lv) is null,'version must belong to requested document');
  update documents set archived_at=now() where id=library_doc;
  perform pg_temp.assert_true(public.read_document_text(owner_id::text,'',library_doc,lv) is null,'archived document cannot be read');
  update document_versions set deleted_at=now() where id=v1;
  perform pg_temp.assert_true(not exists(select 1 from document_version_texts where version_id=v1),'soft deletion removes stored text');
  perform pg_temp.assert_true(not public.publish_document_text(v1,old_revision,'deleted bytes','hash',0),'deleted version cannot be repopulated');
  perform pg_temp.assert_true(not has_table_privilege('authenticated','public.document_version_texts','select'),'text table is server-only');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','public.find_document_text(text,text,text,text,text,uuid,uuid,uuid,integer,integer)','execute'),'caller cannot spoof server actor');
end;
$$;
rollback;
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
do $$
declare actor uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid(); v1 uuid; v2 uuid; revision uuid; r jsonb;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into documents(id,user_id,status) values(doc,actor,'ready');
  alter table document_versions disable trigger document_text_changed;
  v1:=(public.create_document_version(doc,'{"filename":"one.docx","storage_path":"one.docx","file_type":"docx"}',true)->>'id')::uuid;
  v2:=(public.create_document_version(doc,'{"filename":"two.docx","storage_path":"two.docx","file_type":"docx"}',true)->>'id')::uuid;
  alter table document_versions enable trigger document_text_changed;
  perform set_config('mike.backfill_doc',doc::text,true);
  perform set_config('mike.backfill_actor',actor::text,true);
  perform set_config('mike.backfill_v1',v1::text,true);
  perform set_config('mike.backfill_v2',v2::text,true);
end;
$$;
-- Versions from before text search have no text row. The upgrade that made
-- the sweep start from unfinished rows records them as pending first.
\ir ../../../../migrations/20261101_23_document_text_backfill_from_unfinished.sql
do $$
declare actor uuid:=current_setting('mike.backfill_actor')::uuid; v1 uuid:=current_setting('mike.backfill_v1')::uuid;
  v2 uuid:=current_setting('mike.backfill_v2')::uuid; revision uuid; r jsonb;
begin
  perform pg_temp.assert_true(public.backfill_document_text(1,false)=1,'bounded first batch');
  perform pg_temp.assert_true(exists(select 1 from db_jobs where dedupe_key like 'document.text:'||v2||':%')
    and not exists(select 1 from db_jobs where dedupe_key like 'document.text:'||v1||':%'),'current versions prioritized');
  perform pg_temp.assert_true(public.backfill_document_text(1,false)=1,'resumes into history');
  perform pg_temp.assert_true(public.backfill_document_text(1,false)=0,'live jobs deduplicated');
  update document_version_texts set status='failed',error_code='extraction_failed' where version_id=v2;
  update db_jobs set status='failed' where kind='document.extract_text' and payload->>'versionId'=v2::text;
  perform pg_temp.assert_true(public.backfill_document_text(10,false)=0,'failed extraction does not loop forever');
  r:=public.find_document_text(actor::text,'','personal','library','word');
  perform pg_temp.assert_true((r#>>'{coverage,failed_versions}')::int=1,'failure coverage survives job retention');
  perform pg_temp.assert_true(public.backfill_document_text(10,true)=1,'explicit retries repair failed extraction');
  select text_revision into revision from document_versions where id=v2;
  perform public.publish_document_text(v2,revision,'','hash',0);
  perform pg_temp.assert_true((select status='ready' and text_content='' from document_version_texts where version_id=v2),'empty success differs from missing extraction');
  perform pg_temp.assert_true(public.backfill_document_text(10,true)=0,'ready empty documents are never re-extracted');
end;
$$;
rollback;

begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
do $$
declare
  actor uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  v1 uuid;
  v2 uuid;
  rev1 uuid;
  rev2 uuid;
  r jsonb;
begin
  insert into auth.users(id, email) values(actor, actor || '@rag.test');
  insert into public.documents(id, user_id, library_kind, status) values(doc, actor, 'file', 'ready');
  v1 := (public.create_document_version(doc, '{"filename":"clause.pdf","storage_path":"rag/one.pdf","file_type":"pdf"}', true)->>'id')::uuid;
  select text_revision into rev1 from public.document_versions where id = v1;
  perform public.publish_document_text(v1, rev1, '[Page 1]
Clausola compromissoria arbitrale', 'hash1', 0);
  perform pg_temp.assert_true(public.queue_document_embeddings(v1, 'bge-m3@2', false), 'queues embedding job for ready version');
  perform pg_temp.assert_true(public.replace_document_text_chunks(
    v1, rev1, 'bge-m3@2',
    '[{"chunk_index":0,"page_start":1,"page_end":1,"start_char":0,"end_char":33,"content":"Clausola compromissoria arbitrale","embedding":"[1,0]"}]'::jsonb
  ), 'publishes chunks for current revision');
  r := public.search_document_chunks(actor::text, '', 'personal', 'library', 'arbitrale', '[1,0]', 'bge-m3@2', null, null, 5);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches') = 1, 'finds embedded chunk on live version');

  -- Soft deletion removes derived chunks and embedding status immediately and refuses late writes.
  update public.document_versions set deleted_at = now() where id = v1;
  perform pg_temp.assert_true(not exists(select 1 from public.document_text_chunks where version_id = v1), 'soft delete removes chunks');
  perform pg_temp.assert_true(not exists(select 1 from public.document_embedding_status where version_id = v1), 'soft delete removes embedding status');
  perform pg_temp.assert_true(not public.replace_document_text_chunks(v1, rev1, 'bge-m3@2', '[]'::jsonb), 'deleted version rejects late chunk publish');
  perform pg_temp.assert_true(not public.queue_document_embeddings(v1, 'bge-m3@2', true), 'deleted version rejects embedding queue');

  -- Storage path removal (delete_document_version / replacement) also removes derived chunks and status.
  v2 := (public.create_document_version(doc, '{"filename":"clause2.pdf","storage_path":"rag/two.pdf","file_type":"pdf"}', true)->>'id')::uuid;
  select text_revision into rev2 from public.document_versions where id = v2;
  perform public.publish_document_text(v2, rev2, '[Page 1]
Secondo documento', 'hash2', 0);
  perform public.queue_document_embeddings(v2, 'bge-m3@2', false);
  perform public.replace_document_text_chunks(
    v2, rev2, 'bge-m3@2',
    '[{"chunk_index":0,"page_start":1,"page_end":1,"start_char":0,"end_char":17,"content":"Secondo documento","embedding":"[0,1]"}]'::jsonb
  );
  -- Negative access tests: another user cannot retrieve personal library or document chunks.
  r := public.search_document_chunks(gen_random_uuid()::text, '', 'personal', 'library', 'Secondo', '[0,1]', 'bge-m3@2', null, null, 5);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches') = 0 and (r#>>'{coverage,total_versions}')::int = 0, 'another user cannot semantically search personal library');
  r := public.search_document_chunks(gen_random_uuid()::text, '', 'personal', 'document', 'Secondo', '[0,1]', 'bge-m3@2', null, doc, 5);
  perform pg_temp.assert_true(jsonb_array_length(r->'matches') = 0, 'another user cannot semantically search unshared document');

  -- Deleting the text row removes chunks/status and causes replace_document_text_chunks to return false.
  perform pg_temp.assert_true(exists(select 1 from public.document_text_chunks where version_id = v2), 'chunks exist before text row delete');
  perform pg_temp.assert_true(exists(select 1 from public.document_embedding_status where version_id = v2), 'embedding status exists before text row delete');
  delete from public.document_version_texts where version_id = v2;
  perform pg_temp.assert_true(not exists(select 1 from public.document_text_chunks where version_id = v2), 'text row delete removes chunks');
  perform pg_temp.assert_true(not exists(select 1 from public.document_embedding_status where version_id = v2), 'text row delete removes embedding status');
  perform pg_temp.assert_true(not public.replace_document_text_chunks(v2, rev2, 'bge-m3@2', '[]'::jsonb), 'missing text row rejects chunk replacement');

  -- Storage-path removal independently deletes chunks and status on its own populated version.
  declare v3 uuid; rev3 uuid; begin
    v3 := (public.create_document_version(doc, '{"filename":"clause3.pdf","storage_path":"rag/three.pdf","file_type":"pdf"}', true)->>'id')::uuid;
    select text_revision into rev3 from public.document_versions where id = v3;
    perform public.publish_document_text(v3, rev3, '[Page 1]\nTerzo documento', 'hash3', 0);
    perform public.queue_document_embeddings(v3, 'bge-m3@2', false);
    perform public.replace_document_text_chunks(
      v3, rev3, 'bge-m3@2',
      '[{"chunk_index":0,"page_start":1,"page_end":1,"start_char":0,"end_char":15,"content":"Terzo documento","embedding":"[0,1]"}]'::jsonb
    );
    perform pg_temp.assert_true(exists(select 1 from public.document_text_chunks where version_id = v3), 'v3 chunks exist before storage_path clear');
    update public.document_versions set storage_path = null where id = v3;
    perform pg_temp.assert_true(not exists(select 1 from public.document_text_chunks where version_id = v3), 'storage_path removal deletes chunks');
    perform pg_temp.assert_true(not exists(select 1 from public.document_embedding_status where version_id = v3), 'storage_path removal deletes status');
  end;
end;
$$;
rollback;
