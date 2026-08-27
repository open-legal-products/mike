-- Migration date: 2026-08-27
-- Allow a user to run multiple independent upload sessions concurrently.

create or replace function public.create_upload_session(
  target_session_id uuid,
  target_user_id uuid,
  target_purpose text,
  target_destination jsonb,
  target_expires_at timestamptz,
  target_files jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  manifest_file_count integer;
  manifest_total_bytes bigint;
  recent_session_count integer;
begin
  if jsonb_typeof(target_files) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;
  if target_expires_at <= now()
     or target_expires_at > now() + interval '30 minutes' then
    raise exception using errcode = '22023', message = 'invalid_upload_session_expiry';
  end if;

  select count(*), coalesce(sum(file_row.expected_size_bytes), 0)
    into manifest_file_count, manifest_total_bytes
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );

  if manifest_file_count < 1 or manifest_file_count > 50 then
    raise exception using errcode = '22023', message = 'upload_file_count_limit_exceeded';
  end if;
  if manifest_total_bytes < 1 or manifest_total_bytes > 2147483648 then
    raise exception using errcode = '22023', message = 'upload_total_size_limit_exceeded';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(target_files) as file_row(
      id uuid,
      resource_id uuid,
      client_id text,
      filename text,
      target_folder_id uuid,
      file_type text,
      content_type text,
      expected_size_bytes bigint,
      staging_storage_path text,
      sealed_storage_path text
    )
    where file_row.id is null
       or file_row.resource_id is null
       or length(file_row.client_id) not between 1 and 128
       or length(file_row.filename) not between 1 and 255
       or file_row.file_type not in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')
       or length(file_row.content_type) not between 1 and 255
       or file_row.expected_size_bytes not between 1 and 104857600
       or length(file_row.staging_storage_path) < 1
       or length(file_row.sealed_storage_path) < 1
  ) then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));

  if target_purpose in (
    'document_version_create',
    'document_version_replace',
    'workflow_reference_replace'
  ) and exists (
    select 1
    from public.upload_sessions
    where user_id = target_user_id
      and purpose = target_purpose
      and (
        (target_purpose = 'document_version_create'
          and destination ->> 'document_id' = target_destination ->> 'document_id')
        or (target_purpose = 'document_version_replace'
          and destination ->> 'document_id' = target_destination ->> 'document_id'
          and destination ->> 'version_id' = target_destination ->> 'version_id')
        or (target_purpose = 'workflow_reference_replace'
          and destination ->> 'workflow_id' = target_destination ->> 'workflow_id'
          and destination ->> 'reference_id' = target_destination ->> 'reference_id')
      )
      and status in ('pending_upload', 'verifying', 'uploaded', 'processing')
  ) then
    raise exception using errcode = 'P0001', message = 'upload_target_busy';
  end if;

  select count(*)
    into recent_session_count
  from public.upload_sessions
  where user_id = target_user_id
    and created_at > now() - interval '1 hour';

  if recent_session_count >= 50 then
    raise exception using errcode = 'P0001', message = 'upload_session_rate_limit_exceeded';
  end if;

  update public.upload_sessions
  set status = 'expired', updated_at = now()
  where user_id = target_user_id
    and status = 'pending_upload'
    and expires_at <= now();

  update public.upload_sessions
  set status = 'error', updated_at = now()
  where user_id = target_user_id
    and status = 'verifying'
    and updated_at <= now() - interval '5 minutes';

  insert into public.upload_sessions (
    id,
    user_id,
    purpose,
    destination,
    expected_file_count,
    expected_total_bytes,
    expires_at
  ) values (
    target_session_id,
    target_user_id,
    target_purpose,
    target_destination,
    manifest_file_count,
    manifest_total_bytes,
    target_expires_at
  );

  insert into public.upload_session_files (
    id,
    session_id,
    resource_id,
    client_id,
    filename,
    target_folder_id,
    file_type,
    content_type,
    expected_size_bytes,
    staging_storage_path,
    sealed_storage_path
  )
  select
    file_row.id,
    target_session_id,
    file_row.resource_id,
    file_row.client_id,
    file_row.filename,
    file_row.target_folder_id,
    file_row.file_type,
    file_row.content_type,
    file_row.expected_size_bytes,
    file_row.staging_storage_path,
    file_row.sealed_storage_path
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );
end;
$$;

revoke all on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute
  on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb)
  to service_role;
