-- Run only on a disposable database after schema.sql / migrations.
-- Every synthetic row and temporary test trigger is rolled back.
\set ON_ERROR_STOP on
begin;
do $$
declare
  actor uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  other_doc uuid := gen_random_uuid();
  project uuid := gen_random_uuid();
  v1 uuid := gen_random_uuid();
  v2 uuid := gen_random_uuid();
  v3 uuid := gen_random_uuid();
  result jsonb;
  before_jobs integer;
begin
  insert into auth.users(id, email) values(actor, 'lifecycle-test@example.invalid');
  insert into public.projects(id, user_id, name) values(project, actor, 'Lifecycle test');
  insert into public.documents(id, user_id, project_id) values(doc, actor, project), (other_doc, actor, project);
  perform public.create_document_version(doc, jsonb_build_object(
    'id', v1, 'filename', 'one.pdf', 'file_type', 'pdf', 'source', 'upload',
    'version_number', 1, 'storage_path', 'test/shared.pdf', 'pdf_storage_path', 'test/shared.pdf'));
  result := public.create_document_version(doc, jsonb_build_object(
    'id', v2, 'filename', 'two.docx', 'source', 'user_upload',
    'storage_path', 'test/two.docx', 'pdf_storage_path', 'test/two.pdf'));
  assert (result->>'version_number')::int = 2, 'version number allocation';
  assert (select current_version_id = v2 from public.documents where id = doc), 'atomic activation';
  perform public.create_document_version(doc, jsonb_build_object('id', v1, 'filename', 'retry.pdf'));
  assert (select current_version_id = v2 from public.documents where id = doc), 'retry must not reactivate old version';
  assert (select filename = 'one.pdf' from public.document_versions where id = v1), 'retry must not overwrite metadata';
  begin
    perform public.create_document_version(other_doc, jsonb_build_object('id', v1));
    raise exception 'identity conflict was accepted';
  exception when unique_violation then null;
  end;
  select count(*) into before_jobs from public.db_jobs where kind = 'document.cleanup';
  -- Deliberate rollback after creation: neither version nor activation survives.
  begin
    perform public.create_document_version(doc, jsonb_build_object('id', v3, 'storage_path', 'test/rolled-back'));
    raise exception 'rollback_probe';
  exception when raise_exception then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  assert not exists(select 1 from public.document_versions where id = v3), 'creation rollback';
  assert (select current_version_id = v2 from public.documents where id = doc), 'activation rollback';
  result := public.delete_document_version(doc, v2, actor);
  assert (result->>'current_version_id')::uuid = v1, 'replacement active version';
  assert (select deleted_at is not null and storage_path is null from public.document_versions where id = v2), 'soft deletion';
  assert exists(select 1 from public.db_jobs where kind = 'document.cleanup'
    and payload->>'versionId' = v2::text
    and payload->'keys' @> jsonb_build_array('test/two.docx', 'test/two.pdf', 'extracted-text/' || v2 || '.txt')), 'all three storage artifacts';
  result := public.delete_document_version(doc, v1, actor);
  assert result->>'kind' = 'only_version', 'cannot delete the final live version';
  begin
    perform public.create_document_version(doc, jsonb_build_object('id', v2));
    raise exception 'deleted identity was resurrected';
  exception when unique_violation then null;
  end;
  update public.document_versions set storage_path = 'test/replacement.pdf',
    pdf_storage_path = 'test/replacement.pdf' where id = v1;
  assert exists(select 1 from public.db_jobs where kind = 'document.cleanup'
    and payload->>'versionId' = v1::text and payload->'keys' @> '["test/shared.pdf"]'), 'replacement retires old bytes';
  delete from public.projects where id = project;
  assert not exists(select 1 from public.documents where id = doc), 'project cascade';
  assert exists(select 1 from public.db_jobs where kind = 'document.cleanup'
    and payload->>'versionId' = v1::text
    and payload->'keys' @> jsonb_build_array('test/replacement.pdf', 'extracted-text/' || v1 || '.txt')), 'cascade cleanup';
  assert not has_function_privilege('authenticated', 'public.create_document_version(uuid,jsonb,boolean)', 'EXECUTE'), 'create privilege';
  assert not has_function_privilege('anon', 'public.delete_document_version(uuid,uuid,uuid)', 'EXECUTE'), 'delete privilege';
  assert has_function_privilege('service_role', 'public.create_document_version(uuid,jsonb,boolean)', 'EXECUTE'), 'service privilege';
end;
$$;

-- Batch creation and workflow cascades exercise callers outside documents.
do $$
declare
  d1 uuid := gen_random_uuid();
  d2 uuid := gen_random_uuid();
  v1 uuid := gen_random_uuid();
  v2 uuid := gen_random_uuid();
  workflow uuid := gen_random_uuid();
  result jsonb;
begin
  insert into public.workflows(id, title, type) values(workflow, 'Lifecycle asset test', 'assistant');
  insert into public.documents(id, workflow_id) values(d1, workflow), (d2, workflow);
  result := public.create_document_versions(jsonb_build_array(
    jsonb_build_object('id', v1, 'document_id', d1, 'storage_path', 'test/asset-one', 'version_number', 1),
    jsonb_build_object('id', v2, 'document_id', d2, 'storage_path', 'test/asset-two', 'version_number', 1)));
  assert jsonb_array_length(result) = 2, 'batch return';
  assert (select current_version_id = v1 from public.documents where id = d1), 'batch first activation';
  assert (select current_version_id = v2 from public.documents where id = d2), 'batch second activation';
  assert not public.activate_document_version(d1, v2), 'cannot activate another document version';
  assert public.activate_document_version(d1, v1), 'live version activation';
  begin
    perform public.create_document_versions(jsonb_build_array(
      jsonb_build_object('document_id', d1, 'storage_path', 'test/rolled-back-batch'),
      jsonb_build_object('document_id', d2, 'source', 'invalid-source')));
    raise exception 'invalid batch accepted';
  exception when check_violation then null;
  end;
  assert (select count(*) = 1 from public.document_versions where document_id = d1), 'whole batch rollback';
  assert (select current_version_id = v1 from public.documents where id = d1), 'batch pointer rollback';
  delete from public.workflows where id = workflow;
  assert not exists(select 1 from public.documents where id in (d1, d2)), 'workflow cascade';
  assert exists(select 1 from public.db_jobs where kind = 'document.cleanup' and payload->>'versionId' = v1::text), 'workflow cleanup';
end;
$$;


-- Cleanup cannot be stranded by an exhausted stale claim or an older worker
-- rejecting the new kind during migration-before-code rollout.
do $$
declare
  kind_name text;
  failed_id uuid;
  stale_id uuid;
  ordinary_id uuid := gen_random_uuid();
  row_data public.db_jobs%rowtype;
begin
  foreach kind_name in array array['storage.cleanup', 'document.cleanup'] loop
    failed_id := gen_random_uuid(); stale_id := gen_random_uuid();
    insert into public.db_jobs(id, kind, payload, status, attempts, max_attempts, finished_at, last_error)
      values(failed_id, kind_name, '{}', 'failed', 8, 8, now(), 'unknown job kind: ' || kind_name);
    select * into row_data from public.claim_db_job(failed_id);
    assert row_data.status = 'running' and row_data.attempts = 9 and row_data.finished_at is null, 'rollout rejection must be recoverable';
    update public.db_jobs set status = 'failed' where id = failed_id;
    perform public.claim_db_jobs(1000);
    assert (select status = 'running' from public.db_jobs where id = failed_id), 'poll path must recover failed cleanup too';
    insert into public.db_jobs(id, kind, payload, status, attempts, max_attempts, claimed_at)
      values(stale_id, kind_name, '{}', 'running', 2147483647, 2147483647, now() - interval '1 hour');
    select * into row_data from public.claim_db_job(stale_id);
    assert row_data.status = 'running' and row_data.attempts = 2147483647, 'stale cleanup survives attempt exhaustion and integer overflow';
    update public.db_jobs set claimed_at = now() - interval '1 hour' where id = stale_id;
    perform public.claim_db_jobs(1000);
    assert (select status = 'running' and claimed_at > now() - interval '1 minute' from public.db_jobs where id = stale_id), 'batch path reclaims exhausted cleanup';
  end loop;
  insert into public.db_jobs(id, kind, payload, status, attempts, max_attempts, claimed_at)
    values(ordinary_id, 'test.finite', '{}', 'running', 8, 8, now() - interval '1 hour');
  perform public.claim_db_jobs(1000);
  assert (select status = 'failed' from public.db_jobs where id = ordinary_id), 'ordinary job attempt limit retained';
end;
$$;

create function pg_temp.reject_document_cleanup() returns trigger language plpgsql as $$
begin
  if new.kind = 'document.cleanup' then raise exception 'cleanup_insert_rejected'; end if;
  return new;
end;
$$;
create trigger lifecycle_test_reject_cleanup before insert on public.db_jobs
for each row execute function pg_temp.reject_document_cleanup();
do $$
declare
  doc uuid := gen_random_uuid();
  version uuid := gen_random_uuid();
begin
  insert into public.documents(id) values(doc);
  perform public.create_document_version(doc, jsonb_build_object('id', version, 'storage_path', 'test/retained'));
  begin
    delete from public.documents where id = doc;
    raise exception 'delete committed without cleanup';
  exception when raise_exception then
    if sqlerrm <> 'cleanup_insert_rejected' then raise; end if;
  end;
  assert exists(select 1 from public.documents where id = doc), 'parent deletion must roll back';
  assert exists(select 1 from public.document_versions where id = version), 'version deletion must roll back';
end;
$$;
rollback;
\echo Document lifecycle transaction checks passed.
