-- Run only on a disposable database after schema.sql / migrations, as its owner.
-- All synthetic rows, helpers and test triggers are rolled back. No external
-- workers or storage are needed. Concurrent publishers/lost acknowledgements
-- require separate multi-session tests; this covers the persistence boundary.
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;

-- Include the candidate even when its version row has disappeared, so orphaned
-- trigger-created jobs cannot escape the rollback/no-debris assertions.
create function pg_temp.review_document_state(doc uuid, candidate uuid)
returns jsonb language sql as $$
  with versions as (
    select id from public.document_versions where document_id = doc
    union select candidate
  )
  select jsonb_build_object(
    'document', (select to_jsonb(d) from public.documents d where id = doc),
    'versions', (select jsonb_agg(to_jsonb(v) order by v.id)
      from public.document_versions v where document_id = doc or id = candidate),
    'edits', (select jsonb_agg(to_jsonb(e) order by e.id)
      from public.document_edits e where document_id = doc or version_id = candidate),
    'texts', (select jsonb_agg(to_jsonb(t) order by t.version_id)
      from public.document_version_texts t where version_id in (select id from versions)),
    'jobs', (select jsonb_agg(to_jsonb(j) order by j.id) from public.db_jobs j
      where payload->>'versionId' in (select id::text from versions))
  );
$$;

-- Fail after a prior edit, after both edits, or after activation respectively.
-- Check the real text-cache/job triggers have already run at every failure site.
create function pg_temp.reject_review_publication() returns trigger language plpgsql as $$
declare
  stage text := tg_argv[0];
  version uuid;
begin
  if current_setting('test.review_publication_failure', true) is distinct from stage then
    return new;
  end if;
  if stage = 'edit_insert' then
    if new.change_id <> 'replace-terms' then return new; end if;
    version := new.version_id;
  elsif stage = 'activation' then
    version := new.current_version_id;
  else
    version := new.edited_version_id;
    assert (select current_version_id = version from public.documents where id = new.document_id),
      'final run failure must occur after activation';
  end if;
  assert exists(select 1 from public.document_version_texts where version_id = version),
    'text-cache trigger ran before failure';
  assert exists(select 1 from public.db_jobs
    where kind = 'document.extract_text' and payload->>'versionId' = version::text),
    'text-job trigger ran before failure';
  assert (select count(*) = case when stage = 'edit_insert' then 1 else 2 end
    from public.document_edits where version_id = version), 'earlier edit writes reached';
  raise exception 'publication_test_%', stage;
end;
$$;
create trigger publication_test_edit before insert on public.document_edits
for each row execute function pg_temp.reject_review_publication('edit_insert');
create trigger publication_test_activation before update of current_version_id on public.documents
for each row execute function pg_temp.reject_review_publication('activation');
create trigger publication_test_run before update of status on public.playbook_runs
for each row execute function pg_temp.reject_review_publication('final_run_update');

do $$
declare
  actor uuid := gen_random_uuid();
  other_actor uuid := gen_random_uuid();
  book uuid := gen_random_uuid();
  doc uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  winner uuid := gen_random_uuid();
  later uuid := gen_random_uuid();
  review uuid := gen_random_uuid();
  winner_run uuid := review;
  edit_one uuid := gen_random_uuid();
  edit_two uuid := gen_random_uuid();
  candidate uuid;
  findings jsonb := '[{"rule":"terms","result":"issue"},
    {"rule":"unmatched","result":"skipped"},{"rule":"law","result":"issue"}]';
  edits jsonb;
  version_input jsonb;
  expected_findings jsonb;
  annotation jsonb;
  result jsonb;
  saved_winner jsonb;
  before_run jsonb;
  before_document jsonb;
  test_case text;
  signature text := 'public.publish_playbook_review(uuid,uuid,text,jsonb,uuid,uuid,text,jsonb,jsonb)';
begin
  assert not has_function_privilege('anon', signature, 'EXECUTE'), 'anonymous publication forbidden';
  assert not has_function_privilege('authenticated', signature, 'EXECUTE'), 'client publication forbidden';
  assert has_function_privilege('service_role', signature, 'EXECUTE'), 'service publication permitted';

  insert into auth.users(id, email) values
    (actor, 'review-publication@example.invalid'), (other_actor, 'review-other@example.invalid');
  insert into public.playbooks(id, user_id, name, content_json)
    values(book, actor, 'Publication test', '{}');
  insert into public.documents(id, user_id) values(doc, actor);
  perform public.create_document_version(doc, jsonb_build_object(
    'id', source, 'version_number', 1, 'filename', 'source.docx', 'file_type', 'docx',
    'source', 'upload', 'storage_path', 'test/review-source.docx'));
  insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
    model, review_mode, status, started_at, error)
    values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'old error');
  version_input := jsonb_build_object('id', winner, 'filename', 'review.docx',
    'file_type', 'docx', 'source', 'assistant_edit', 'storage_path', 'test/review-result.docx',
    'size_bytes', 123, 'page_count', 2);
  -- Deliberately reverse finding order and omit optional fields from one edit.
  edits := jsonb_build_array(
    jsonb_build_object('id', edit_two, 'finding_index', 2, 'change_id', 'insert-law'),
    jsonb_build_object('id', edit_one, 'finding_index', 0, 'change_id', 'replace-terms',
      'del_w_id', '12', 'ins_w_id', '13', 'deleted_text', 'old', 'inserted_text', 'new',
      'context_before', 'before', 'context_after', 'after', 'reason', 'Apply the rule'));
  expected_findings := jsonb_build_array(
    findings->0 || jsonb_build_object('edit', jsonb_build_object(
      'kind', 'edit', 'edit_id', edit_one, 'document_id', doc, 'version_id', winner,
      'version_number', 2, 'change_id', 'replace-terms', 'del_w_id', '12', 'ins_w_id', '13',
      'deleted_text', 'old', 'inserted_text', 'new', 'context_before', 'before',
      'context_after', 'after', 'reason', 'Apply the rule', 'status', 'pending')),
    findings->1,
    findings->2 || jsonb_build_object('edit', jsonb_build_object(
      'kind', 'edit', 'edit_id', edit_two, 'document_id', doc, 'version_id', winner,
      'version_number', 2, 'change_id', 'insert-law', 'deleted_text', '', 'inserted_text', '',
      'context_before', '', 'context_after', '', 'status', 'pending')));

  result := public.publish_playbook_review(review, actor, 'Saved review', findings,
    doc, source, 'test/review-source.docx', version_input, edits);
  assert result->>'disposition' = 'published', 'native publication';
  select to_jsonb(r) into saved_winner from public.playbook_runs r where id = review;
  assert result->'run' = saved_winner, 'return the durable run';
  assert saved_winner->'findings_json' = expected_findings, 'exact links and untouched skipped finding';
  assert saved_winner->>'status' = 'completed' and saved_winner->>'summary' = 'Saved review'
    and (saved_winner->>'edited_version_id')::uuid = winner and saved_winner->>'error' is null
    and saved_winner->>'completed_at' is not null
    and saved_winner->'completed_at' = saved_winner->'updated_at', 'complete run metadata';
  assert (select count(*) = 2 from public.document_versions where document_id = doc), 'one result version';
  assert (select current_version_id = winner from public.documents where id = doc), 'result activated';
  assert result->'version' = (select to_jsonb(v) from public.document_versions v where id = winner),
    'return the durable version';
  assert result->'version' @> (version_input || jsonb_build_object('document_id', doc, 'version_number', 2)),
    'version metadata and allocated number';
  assert (select count(*) = 2 from public.document_edits where document_id = doc), 'one row per linked finding';
  for annotation in select value->'edit' from jsonb_array_elements(expected_findings) where value ? 'edit' loop
    assert exists(select 1 from public.document_edits e where id = (annotation->>'edit_id')::uuid
      and chat_message_id is null and resolved_at is null
      and jsonb_strip_nulls(to_jsonb(e) - array['id', 'created_at', 'chat_message_id', 'resolved_at'])
        = annotation - array['kind', 'edit_id', 'version_number', 'reason']), 'exact persisted edit';
  end loop;
  assert exists(select 1 from public.document_version_texts t join public.document_versions v on v.id = t.version_id
    where t.version_id = winner and t.source_revision = v.text_revision and t.status = 'pending'), 'real text cache created';
  assert (select count(*) = 1 from public.db_jobs
    where kind = 'document.extract_text' and payload->>'versionId' = winner::text), 'real extraction job created';

  -- A replay must return the saved winner even with different candidate content
  -- and a now-stale source. It must never reactivate over a newer user version.
  perform public.create_document_version(doc, jsonb_build_object(
    'id', later, 'filename', 'later.docx', 'file_type', 'docx', 'source', 'user_upload',
    'storage_path', 'test/review-later.docx'));
  candidate := gen_random_uuid();
  version_input := version_input || jsonb_build_object('id', candidate);
  edits := jsonb_set(jsonb_set(edits, '{0,id}', to_jsonb(gen_random_uuid())), '{1,id}', to_jsonb(gen_random_uuid()));
  before_document := pg_temp.review_document_state(doc, candidate);
  result := public.publish_playbook_review(winner_run, actor, 'Ignored replay', findings,
    doc, source, 'test/review-source.docx', version_input, edits);
  assert result = jsonb_build_object('disposition', 'existing', 'run', saved_winner), 'replay returns saved winner';
  assert pg_temp.review_document_state(doc, candidate) = before_document, 'replay makes no document writes';
  assert (select to_jsonb(r) = saved_winner from public.playbook_runs r where id = winner_run), 'replay preserves run';

  review := gen_random_uuid();
  insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
    model, review_mode, status, started_at)
    values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now());
  foreach test_case in array array['missing', 'wrong_owner', 'terminal'] loop
    if test_case = 'terminal' then
      update public.playbook_runs set status = 'failed', error = 'Already failed' where id = review;
    end if;
    select to_jsonb(r) into before_run from public.playbook_runs r where id = review;
    result := public.publish_playbook_review(
      case when test_case = 'missing' then gen_random_uuid() else review end,
      case when test_case = 'wrong_owner' then other_actor else actor end,
      'Must not publish', findings, doc, later, 'test/review-later.docx', version_input, edits);
    assert result = case when test_case = 'terminal'
      then jsonb_build_object('disposition', 'terminal', 'run', before_run)
      else jsonb_build_object('disposition', 'missing') end, 'missing/owner/terminal guard';
    assert (select to_jsonb(r) = before_run from public.playbook_runs r where id = review), 'guard preserves run';
    assert pg_temp.review_document_state(doc, candidate) = before_document, 'guard makes no document writes';
  end loop;

  -- Both a changed pointer and in-place source-byte replacement fall back to
  -- unlinked text-only findings, without versions, edits, cache rows or jobs.
  foreach test_case in array array['pointer', 'bytes'] loop
    if test_case = 'bytes' then
      update public.document_versions set storage_path = 'test/review-replaced.docx' where id = later;
    end if;
    review := gen_random_uuid();
    insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
      model, review_mode, status, started_at, error)
      values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'old error');
    before_document := pg_temp.review_document_state(doc, candidate);
    result := public.publish_playbook_review(review, actor, 'Source changed', findings, doc,
      case when test_case = 'pointer' then source else later end,
      case when test_case = 'pointer' then 'test/review-source.docx' else 'test/review-later.docx' end,
      version_input, edits);
    assert result->>'disposition' = 'source_changed' and result->'version' = 'null'::jsonb, 'source conflict disposition';
    assert result->'run' = (select to_jsonb(r) from public.playbook_runs r where id = review), 'durable conflict result';
    assert result->'run'->'findings_json' = findings and result->'run'->>'edited_version_id' is null
      and result->'run'->>'status' = 'completed' and result->'run'->>'summary' = 'Source changed'
      and result->'run'->>'error' is null and result->'run'->>'completed_at' is not null,
      'source conflict saves only unlinked findings';
    assert pg_temp.review_document_state(doc, candidate) = before_document, 'source conflict leaves no debris';
  end loop;

  foreach test_case in array array['edit_insert', 'activation', 'final_run_update'] loop
    review := gen_random_uuid();
    candidate := gen_random_uuid();
    version_input := version_input || jsonb_build_object('id', candidate);
    insert into public.playbook_runs(id, playbook_id, user_id, document_id, content_json,
      model, review_mode, status, started_at, summary, findings_json, error)
      values(review, book, actor, doc, '{}', 'synthetic', 'strict', 'running', now(), 'Before', '[]', 'Before error');
    select to_jsonb(r) into before_run from public.playbook_runs r where id = review;
    before_document := pg_temp.review_document_state(doc, candidate);
    perform set_config('test.review_publication_failure', test_case, true);
    begin
      perform public.publish_playbook_review(review, actor, 'Must roll back', findings,
        doc, later, 'test/review-replaced.docx', version_input, edits);
      raise exception 'expected publication failure was not raised';
    exception when raise_exception then
      if sqlerrm <> 'publication_test_' || test_case then raise; end if;
    end;
    perform set_config('test.review_publication_failure', '', true);
    assert (select to_jsonb(r) = before_run from public.playbook_runs r where id = review), 'entire run write rolls back';
    assert pg_temp.review_document_state(doc, candidate) = before_document,
      'version, edits, activation, text cache and extraction jobs all roll back';
  end loop;
end;
$$;
rollback;
\echo Playbook review publication transaction checks passed.
