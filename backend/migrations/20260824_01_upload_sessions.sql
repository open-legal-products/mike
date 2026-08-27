-- Migration date: 2026-08-24
-- Create the final direct-upload session schema: concurrent sessions,
-- per-file processing jobs, configurable creation limits, and worker audit
-- attribution.
begin;

create table if not exists public.upload_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null,
  destination jsonb not null,
  expected_file_count integer not null,
  expected_total_bytes bigint not null,
  status text not null default 'pending_upload',
  expires_at timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_email text,
  constraint upload_sessions_purpose_check check (
    purpose in (
      'document_create',
      'document_version_create',
      'document_version_replace',
      'workflow_reference_create',
      'workflow_reference_replace'
    )
  ),
  constraint upload_sessions_destination_object_check
    check (jsonb_typeof(destination) = 'object'),
  constraint upload_sessions_file_count_check
    check (expected_file_count between 1 and 50),
  constraint upload_sessions_total_bytes_check
    check (expected_total_bytes between 1 and 2147483648),
  constraint upload_sessions_status_check check (
    status in (
      'pending_upload',
      'verifying',
      'uploaded',
      'processing',
      'completed',
      'cancelled',
      'expired',
      'error'
    )
  )
);

create or replace function public.capture_upload_session_user_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select email
    into new.user_email
  from auth.users
  where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists capture_upload_session_user_email on public.upload_sessions;
create trigger capture_upload_session_user_email
  before insert on public.upload_sessions
  for each row
  execute function public.capture_upload_session_user_email();

revoke all on function public.capture_upload_session_user_email()
  from public, anon, authenticated;

create index if not exists upload_sessions_user_created_idx
  on public.upload_sessions(user_id, created_at desc);

drop index if exists public.upload_sessions_active_idx;
create index upload_sessions_active_idx
  on public.upload_sessions(user_id, expires_at)
  where status in ('pending_upload', 'verifying', 'uploaded', 'processing');

create table if not exists public.upload_session_files (
  id uuid primary key,
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  resource_id uuid not null,
  client_id text not null,
  filename text not null,
  target_folder_id uuid,
  file_type text not null,
  content_type text not null,
  expected_size_bytes bigint not null,
  observed_size_bytes bigint,
  staging_storage_path text not null,
  sealed_storage_path text not null,
  etag text,
  status text not null default 'pending_upload',
  error_code text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_session_files_client_id_check
    check (length(client_id) between 1 and 128),
  constraint upload_session_files_filename_check
    check (length(filename) between 1 and 255),
  constraint upload_session_files_file_type_check
    check (file_type in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')),
  constraint upload_session_files_content_type_check
    check (length(content_type) between 1 and 255),
  constraint upload_session_files_size_check
    check (expected_size_bytes between 1 and 104857600),
  constraint upload_session_files_observed_size_check
    check (observed_size_bytes is null or observed_size_bytes >= 0),
  constraint upload_session_files_status_check
    check (status in ('pending_upload', 'verifying', 'uploaded', 'processing', 'completed', 'error')),
  constraint upload_session_files_session_client_unique unique(session_id, client_id),
  constraint upload_session_files_session_resource_unique unique(session_id, resource_id),
  constraint upload_session_files_staging_path_unique unique(staging_storage_path),
  constraint upload_session_files_sealed_path_unique unique(sealed_storage_path)
);

create index if not exists upload_session_files_session_idx
  on public.upload_session_files(session_id, created_at);

create table if not exists public.upload_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  file_id uuid not null unique references public.upload_session_files(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_processing_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'error')),
  constraint upload_processing_jobs_attempts_check
    check (attempts between 0 and 10)
);

create index if not exists upload_processing_jobs_ready_idx
  on public.upload_processing_jobs(status, available_at, created_at)
  where status = 'queued';

create index if not exists upload_processing_jobs_session_idx
  on public.upload_processing_jobs(session_id, created_at);

alter table public.upload_sessions enable row level security;
alter table public.upload_session_files enable row level security;
alter table public.upload_processing_jobs enable row level security;

create or replace function public.create_upload_session(
  target_session_id uuid,
  target_user_id uuid,
  target_purpose text,
  target_destination jsonb,
  target_expires_at timestamptz,
  target_files jsonb,
  target_hourly_session_limit integer default 50
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
  -- The API issues a 30-minute expiry. Permit one minute of clock skew between
  -- the application host and Postgres while keeping the issued TTL unchanged.
  if target_expires_at <= now()
     or target_expires_at > now() + interval '31 minutes' then
    raise exception using errcode = '22023', message = 'invalid_upload_session_expiry';
  end if;
  if target_hourly_session_limit not between 1 and 1000000 then
    raise exception using errcode = '22023', message = 'invalid_upload_session_rate_limit';
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

  if recent_session_count >= target_hourly_session_limit then
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

create or replace function public.refresh_upload_session_status(
  target_session_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  pending_file_count integer;
  active_file_count integer;
  completed_file_count integer;
  failed_file_count integer;
  next_status text;
  next_error_code text;
  terminal_at timestamptz;
begin
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
  for update;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    return session_row.status;
  end if;

  select
    count(*) filter (where status in ('pending_upload', 'verifying')),
    count(*) filter (where status in ('uploaded', 'processing')),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'error')
    into pending_file_count, active_file_count, completed_file_count, failed_file_count
  from public.upload_session_files
  where session_id = target_session_id;

  if pending_file_count > 0 then
    next_status := 'pending_upload';
    next_error_code := null;
    terminal_at := null;
  elsif active_file_count > 0 then
    next_status := 'processing';
    next_error_code := null;
    terminal_at := null;
  elsif completed_file_count > 0 then
    next_status := 'completed';
    next_error_code := case when failed_file_count > 0 then 'partial_failure' else null end;
    terminal_at := now();
  else
    next_status := 'error';
    next_error_code := 'all_uploads_failed';
    terminal_at := now();
  end if;

  update public.upload_sessions
  set status = next_status,
      error_code = next_error_code,
      completed_at = terminal_at,
      cleaned_at = case when terminal_at is not null then terminal_at else cleaned_at end,
      updated_at = now()
  where id = target_session_id;

  return next_status;
end;
$$;

create or replace function public.queue_upload_session_file_processing(
  target_session_id uuid,
  target_user_id uuid,
  target_file_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  file_row public.upload_session_files%rowtype;
  processing_job_id uuid;
begin
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
    and user_id = target_user_id
  for update;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'upload_session_not_active';
  end if;

  select *
    into file_row
  from public.upload_session_files
  where id = target_file_id
    and session_id = target_session_id
  for update;

  if file_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_file_not_found';
  end if;
  if file_row.status not in ('uploaded', 'processing', 'completed') then
    raise exception using errcode = 'P0001', message = 'upload_session_file_not_ready';
  end if;

  insert into public.upload_processing_jobs (session_id, file_id, user_id)
  values (target_session_id, target_file_id, target_user_id)
  on conflict (file_id) do update
    set file_id = excluded.file_id
  returning id into processing_job_id;

  return processing_job_id;
end;
$$;

create or replace function public.claim_upload_processing_job(
  target_worker_id text,
  target_lease_seconds integer default 600
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_job_id uuid;
  claimed_session_id uuid;
  claimed_file_id uuid;
begin
  if length(target_worker_id) not between 1 and 200
     or target_lease_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'invalid_upload_worker_claim';
  end if;

  select id, session_id, file_id
    into claimed_job_id, claimed_session_id, claimed_file_id
  from public.upload_processing_jobs
  where attempts < 3
    and ((
      status = 'queued'
      and available_at <= now()
    ) or (
      status = 'running'
      and locked_at <= now() - make_interval(secs => target_lease_seconds)
    ))
  order by available_at, created_at
  for update skip locked
  limit 1;

  if claimed_job_id is null then
    return null;
  end if;

  update public.upload_processing_jobs
  set status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = target_worker_id,
      error_code = null,
      updated_at = now()
  where id = claimed_job_id;

  update public.upload_session_files
  set status = 'processing', error_code = null, updated_at = now()
  where id = claimed_file_id
    and session_id = claimed_session_id
    and (status = 'uploaded' or (status = 'error' and error_code = 'processing_failed'));

  perform public.refresh_upload_session_status(claimed_session_id);

  return claimed_job_id;
end;
$$;

revoke all on public.upload_sessions from anon, authenticated;
revoke all on public.upload_session_files from anon, authenticated;
revoke all on public.upload_processing_jobs from anon, authenticated;
revoke all on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_upload_session_status(uuid)
  from public, anon, authenticated;
revoke all on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_upload_processing_job(text, integer)
  from public, anon, authenticated;

grant select, insert, update, delete on public.upload_sessions to service_role;
grant select, insert, update, delete on public.upload_session_files to service_role;
grant select, insert, update, delete on public.upload_processing_jobs to service_role;
grant execute on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  to service_role;
grant execute on function public.refresh_upload_session_status(uuid)
  to service_role;
grant execute on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  to service_role;
grant execute on function public.claim_upload_processing_job(text, integer)
  to service_role;

commit;
