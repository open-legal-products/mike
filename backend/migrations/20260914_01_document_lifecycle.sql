-- Migration date: 2026-09-14
-- Document metadata and the durable cleanup intent commit together. This also
-- covers cascades from projects, workflows and account erasure.
create or replace function public.queue_document_version_cleanup()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_keys text[] := array[]::text[];
  v_cache boolean := false;
begin
  if tg_op = 'DELETE' then
    v_keys := array[old.storage_path, old.pdf_storage_path];
    v_cache := true;
  else
    if old.storage_path is distinct from new.storage_path then
      v_keys := array_append(v_keys, old.storage_path);
      v_cache := true;
    end if;
    if old.pdf_storage_path is distinct from new.pdf_storage_path then
      v_keys := array_append(v_keys, old.pdf_storage_path);
    end if;
    if old.deleted_at is null and new.deleted_at is not null then
      v_keys := v_keys || array[old.storage_path, old.pdf_storage_path];
      v_cache := true;
    end if;
    if old.content_sha256 is distinct from new.content_sha256 then
      v_cache := true;
    end if;
  end if;
  if v_cache then
    v_keys := array_append(v_keys, 'extracted-text/' || old.id::text || '.txt');
  end if;
  select coalesce(array_agg(distinct k), array[]::text[]) into v_keys
    from unnest(v_keys) k where k is not null and k <> '';
  if cardinality(v_keys) > 0 then
    -- Do not dedupe different mutations of the same version: each may retire
    -- a different source/rendition. Repeated object deletes are idempotent.
    insert into public.db_jobs(kind, payload, max_attempts)
    values ('document.cleanup', jsonb_build_object(
      'versionId', old.id, 'keys', to_jsonb(v_keys)), 8);
  end if;
  return null;
end;
$$;
revoke all on function public.queue_document_version_cleanup() from public, anon, authenticated;
grant execute on function public.queue_document_version_cleanup() to service_role;
drop trigger if exists document_version_cleanup on public.document_versions;
create trigger document_version_cleanup
after delete or update of storage_path, pdf_storage_path, deleted_at, content_sha256
on public.document_versions for each row
execute function public.queue_document_version_cleanup();

-- Authorization remains with the calling service. These are service-role-only
-- persistence primitives; a parent lock serializes number allocation and
-- activation with deletion, including concurrent requests on different hosts.
create or replace function public.create_document_version(
  p_document_id uuid, p_version jsonb, p_activate boolean default true
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := coalesce((p_version->>'id')::uuid, gen_random_uuid());
  v_row public.document_versions%rowtype;
  v_number integer;
begin
  perform 1 from public.documents where id = p_document_id for update;
  if not found then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.document_versions where id = v_id;
  if found then
    if v_row.document_id <> p_document_id or v_row.deleted_at is not null then
      raise exception 'version_identity_conflict' using errcode = '23505';
    end if;
    -- An upload retry must not overwrite metadata or reactivate an older
    -- version after somebody has already created a newer one.
    return to_jsonb(v_row);
  end if;
  v_number := (p_version->>'version_number')::integer;
  if v_number is null then
    select coalesce(max(version_number), 1) + 1 into v_number
    from public.document_versions
    where document_id = p_document_id
      and source in ('upload', 'user_upload', 'assistant_edit');
  end if;
  insert into public.document_versions(
    id, document_id, storage_path, pdf_storage_path, source, version_number,
    filename, file_type, size_bytes, page_count, content_sha256
  ) values (
    v_id, p_document_id, p_version->>'storage_path', p_version->>'pdf_storage_path',
    coalesce(p_version->>'source', 'upload'), v_number,
    p_version->>'filename', p_version->>'file_type',
    (p_version->>'size_bytes')::integer, (p_version->>'page_count')::integer,
    p_version->>'content_sha256'
  ) returning * into v_row;
  if p_activate then
    update public.documents set current_version_id = v_id, updated_at = now()
      where id = p_document_id;
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.create_document_version(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_document_version(uuid, jsonb, boolean) to service_role;

create or replace function public.delete_document_version(
  p_document_id uuid, p_version_id uuid, p_actor_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_current uuid;
  v_next uuid;
  v_deleted_at timestamptz := now();
begin
  select current_version_id into v_current from public.documents
    where id = p_document_id for update;
  if not found then return jsonb_build_object('kind', 'doc_not_found'); end if;
  perform 1 from public.document_versions
    where id = p_version_id and document_id = p_document_id and deleted_at is null;
  if not found then return jsonb_build_object('kind', 'version_not_found'); end if;
  select id into v_next from public.document_versions
    where document_id = p_document_id and id <> p_version_id and deleted_at is null
    order by version_number desc nulls last, created_at desc nulls last, id
    limit 1;
  if v_next is null then return jsonb_build_object('kind', 'only_version'); end if;
  if v_current = p_version_id then
    v_current := v_next;
    update public.documents set current_version_id = v_current, updated_at = now()
      where id = p_document_id;
  end if;
  update public.document_versions set storage_path = null, pdf_storage_path = null,
    deleted_at = v_deleted_at, deleted_by = p_actor_id
    where id = p_version_id and document_id = p_document_id;
  return jsonb_build_object('deleted_version_id', p_version_id,
    'current_version_id', v_current, 'deleted_at', v_deleted_at);
end;
$$;
revoke all on function public.delete_document_version(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_document_version(uuid, uuid, uuid) to service_role;

create or replace function public.create_document_versions(p_versions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_versions) <> 'array' or jsonb_array_length(p_versions) > 500 then
    raise exception 'invalid_version_batch' using errcode = '22023';
  end if;
  -- Consistent lock order prevents overlapping batches from deadlocking.
  perform 1 from public.documents
    where id in (select (value->>'document_id')::uuid from jsonb_array_elements(p_versions))
    order by id for update;
  for item in select value from jsonb_array_elements(p_versions) loop
    result := result || jsonb_build_array(public.create_document_version(
      (item->>'document_id')::uuid, item - 'document_id', true));
  end loop;
  return result;
end;
$$;
revoke all on function public.create_document_versions(jsonb) from public, anon, authenticated;
grant execute on function public.create_document_versions(jsonb) to service_role;

create or replace function public.activate_document_version(p_document_id uuid, p_version_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.documents where id = p_document_id for update;
  if not found then return false; end if;
  perform 1 from public.document_versions
    where id = p_version_id and document_id = p_document_id and deleted_at is null;
  if not found then return false; end if;
  update public.documents set current_version_id = p_version_id, updated_at = now()
    where id = p_document_id;
  return true;
end;
$$;
revoke all on function public.activate_document_version(uuid, uuid) from public, anon, authenticated;
grant execute on function public.activate_document_version(uuid, uuid) to service_role;

-- Cleanup intents survive stale claims and old workers rejecting a new kind
-- during migration-before-code rollout. Both poll and Redis claim paths revive
-- failed cleanup rows; ordinary jobs retain their finite attempt budgets.
create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql set search_path = ''
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind not in ('storage.cleanup', 'document.cleanup')
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'failed'
            and kind in ('storage.cleanup', 'document.cleanup'))
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind in ('storage.cleanup', 'document.cleanup')
            ))
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then null
           else j.dedupe_key
         end
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

-- Claim ONE job by id — the Redis-delivery path (transactional-outbox
-- pattern). When Redis is configured, enqueue also adds a BullMQ "delivery"
-- job carrying this row's id so pickup is instant; the worker still claims
-- through Postgres via this function, so a duplicate delivery (BullMQ retry,
-- poller backstop racing the delivery) can never double-run the job: the
-- second claimer matches zero rows. Same stale-running recovery as the batch
-- claim, including its attempt budget: a job that kills its worker must not be
-- redelivered forever. Terminally failing a spent stale row is left to the
-- batch claim above, which every deployment runs (as the delivery mechanism
-- without Redis, as the lost-delivery backstop with it).
create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql set search_path = ''
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then null
           else j.dedupe_key
         end
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'failed'
           and j.kind in ('storage.cleanup', 'document.cleanup'))
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and (
             j.attempts < j.max_attempts
             or j.kind in ('storage.cleanup', 'document.cleanup')
           )))
  returning j.*;
$$;

drop index if exists public.db_jobs_failed_cleanup_run_at_idx;
create index db_jobs_failed_cleanup_run_at_idx
  on public.db_jobs(run_at)
  where status = 'failed'
    and kind in ('storage.cleanup', 'document.cleanup');
