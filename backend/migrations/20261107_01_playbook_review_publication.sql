-- Migration date: 2026-11-07
-- Publish a review outcome and its document effects in one transaction.
-- Drain old in-flight reviews before deploying the new publisher on all workers.
create or replace function public.publish_playbook_review(
  p_run_id uuid,
  p_user_id uuid,
  p_summary text,
  p_findings jsonb,
  p_document_id uuid default null,
  p_expected_version_id uuid default null,
  p_expected_storage_path text default null,
  p_version jsonb default null,
  p_edits jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.playbook_runs%rowtype;
  v_current uuid;
  v_document_exists boolean := false;
  v_source_exists boolean := false;
  v_source_path text;
  v_source_document_id uuid;
  v_source_deleted timestamptz;
  v_version jsonb;
  v_version_id uuid;
  v_findings jsonb := p_findings;
  v_item jsonb;
  v_index integer;
  v_annotation jsonb;
  v_native boolean := p_version is not null;
  v_disposition text := 'published';
  v_completed_at timestamptz := clock_timestamp();
begin
  if p_summary is null or p_findings is null or jsonb_typeof(p_findings) <> 'array'
     or jsonb_array_length(p_findings) > 1000
     or p_edits is null or jsonb_typeof(p_edits) <> 'array'
     or jsonb_array_length(p_edits) > 1000 then
    raise exception 'invalid_review_publication' using errcode = '22023';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_findings) as f(value)
    where jsonb_typeof(f.value) is distinct from 'object' or f.value ? 'edit'
  ) then
    raise exception 'findings_must_be_unlinked_objects' using errcode = '22023';
  end if;

  -- Parent first, consistent with existing document lifecycle primitives.
  -- Lock source bytes as well: updateDocumentVersion can replace that row's
  -- storage path without updating/locking the parent document pointer.
  if v_native then
    if p_document_id is null or p_expected_version_id is null
       or p_expected_storage_path is null or jsonb_typeof(p_version) <> 'object'
       or jsonb_array_length(p_edits) = 0 then
      raise exception 'invalid_review_document' using errcode = '22023';
    end if;
    select current_version_id into v_current
      from public.documents where id = p_document_id for update;
    v_document_exists := found;
    select storage_path, deleted_at, document_id
      into v_source_path, v_source_deleted, v_source_document_id
      from public.document_versions
      where id = p_expected_version_id
      for share;
    v_source_exists := found;
  elsif jsonb_array_length(p_edits) <> 0 then
    raise exception 'edits_require_version' using errcode = '22023';
  end if;

  select * into v_run from public.playbook_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('disposition', 'missing');
  end if;
  if v_run.status = 'completed' then
    -- Never reactivate a result version after a later edit or user action.
    return jsonb_build_object('disposition', 'existing', 'run', to_jsonb(v_run));
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('disposition', 'terminal', 'run', to_jsonb(v_run));
  end if;

  if v_native then
    if v_source_exists and v_source_document_id <> p_document_id then
      raise exception 'review_source_document_mismatch' using errcode = '22023';
    end if;
    if v_run.document_id is not null and v_run.document_id <> p_document_id then
      raise exception 'review_document_mismatch' using errcode = '22023';
    end if;
    if v_run.document_id is null or not v_document_exists or not v_source_exists
       or v_source_deleted is not null or v_current is distinct from p_expected_version_id
       or v_source_path is distinct from p_expected_storage_path then
      -- Preserve current text-only source-conflict behavior without changing
      -- any document. This is a semantic result, not a DB failure fallback.
      v_native := false;
      v_disposition := 'source_changed';
    end if;
  end if;

  if v_native then
    v_version_id := (p_version->>'id')::uuid;
    if p_version ? 'version_number' then
      raise exception 'review_version_number_is_allocated' using errcode = '22023';
    end if;
    if v_version_id is null or nullif(p_version->>'storage_path', '') is null
       or nullif(p_version->>'filename', '') is null
       or p_version->>'file_type' is distinct from 'docx'
       or p_version->>'source' is distinct from 'assistant_edit' then
      raise exception 'invalid_review_version' using errcode = '22023';
    end if;
    -- A previous successful publication would have made the run completed.
    -- Never quietly adopt unrelated/partial versions via the lifecycle RPC's
    -- idempotency convenience when the run is still running.
    if exists(select 1 from public.document_versions where id = v_version_id) then
      raise exception 'review_version_identity_conflict' using errcode = '23505';
    end if;
    if exists(
      select 1 from jsonb_array_elements(p_edits) as e(value)
      where jsonb_typeof(e.value->'finding_index') is distinct from 'number'
         or e.value->>'id' is null or e.value->>'change_id' is null
    ) or (
      select count(*) <> count(distinct e.value->>'finding_index')
        from jsonb_array_elements(p_edits) as e(value)
    ) then
      raise exception 'invalid_review_edit_links' using errcode = '22023';
    end if;

    v_version := public.create_document_version(p_document_id, p_version, false);
    for v_item in select value from jsonb_array_elements(p_edits) loop
      v_index := (v_item->>'finding_index')::integer;
      if v_index < 0 or v_index >= jsonb_array_length(v_findings) then
        raise exception 'invalid_review_finding_index' using errcode = '22023';
      end if;
      insert into public.document_edits(
        id, document_id, version_id, change_id, del_w_id, ins_w_id,
        deleted_text, inserted_text, context_before, context_after, status
      ) values (
        (v_item->>'id')::uuid, p_document_id, v_version_id,
        v_item->>'change_id', v_item->>'del_w_id', v_item->>'ins_w_id',
        coalesce(v_item->>'deleted_text', ''), coalesce(v_item->>'inserted_text', ''),
        coalesce(v_item->>'context_before', ''), coalesce(v_item->>'context_after', ''), 'pending'
      );
      v_annotation := jsonb_strip_nulls(jsonb_build_object(
        'kind', 'edit', 'edit_id', v_item->>'id', 'document_id', p_document_id,
        'version_id', v_version_id, 'version_number', (v_version->>'version_number')::integer,
        'change_id', v_item->>'change_id', 'del_w_id', v_item->>'del_w_id',
        'ins_w_id', v_item->>'ins_w_id', 'deleted_text', coalesce(v_item->>'deleted_text', ''),
        'inserted_text', coalesce(v_item->>'inserted_text', ''),
        'context_before', coalesce(v_item->>'context_before', ''),
        'context_after', coalesce(v_item->>'context_after', ''),
        'reason', v_item->>'reason', 'status', 'pending'
      ));
      v_findings := jsonb_set(v_findings, array[v_index::text, 'edit'], v_annotation, true);
    end loop;
    if not public.activate_document_version(p_document_id, v_version_id) then
      raise exception 'review_activation_failed' using errcode = 'P0002';
    end if;
  end if;

  update public.playbook_runs set
    status = 'completed', summary = p_summary, findings_json = v_findings,
    edited_version_id = v_version_id, error = null,
    completed_at = v_completed_at, updated_at = v_completed_at
    where id = p_run_id and user_id = p_user_id and status = 'running'
    returning * into v_run;
  if not found then
    raise exception 'review_publication_guard_lost' using errcode = 'P0002';
  end if;
  return jsonb_build_object('disposition', v_disposition, 'run', to_jsonb(v_run), 'version', v_version);
end;
$$;
revoke all on function public.publish_playbook_review(uuid, uuid, text, jsonb, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_playbook_review(uuid, uuid, text, jsonb, uuid, uuid, text, jsonb, jsonb)
  to service_role;
