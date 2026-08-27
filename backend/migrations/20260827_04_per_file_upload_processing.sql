-- Migration date: 2026-08-27

begin;

lock table public.upload_processing_jobs in access exclusive mode;
lock table public.upload_session_files in access exclusive mode;
lock table public.upload_sessions in access exclusive mode;

alter table public.upload_session_files
  drop constraint if exists upload_session_files_status_check;
alter table public.upload_session_files
  add constraint upload_session_files_status_check
  check (status in ('pending_upload', 'verifying', 'uploaded', 'processing', 'completed', 'error'));

alter table public.upload_processing_jobs
  add column if not exists file_id uuid;

-- Requeue any in-flight session jobs at file granularity. Upload processing is
-- idempotent, so restarting an interrupted file is safer than carrying a
-- session-wide lease across the schema change.
update public.upload_session_files
set status = 'uploaded', error_code = null, updated_at = now()
where status = 'processing';
delete from public.upload_processing_jobs;

alter table public.upload_processing_jobs
  drop constraint if exists upload_processing_jobs_session_id_key;
alter table public.upload_processing_jobs
  alter column file_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'upload_processing_jobs_file_id_fkey'
      and conrelid = 'public.upload_processing_jobs'::regclass
  ) then
    alter table public.upload_processing_jobs
      add constraint upload_processing_jobs_file_id_fkey
      foreign key (file_id) references public.upload_session_files(id) on delete cascade;
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'upload_processing_jobs_file_id_key'
      and conrelid = 'public.upload_processing_jobs'::regclass
  ) then
    alter table public.upload_processing_jobs
      add constraint upload_processing_jobs_file_id_key unique (file_id);
  end if;
end;
$$;

create index if not exists upload_processing_jobs_session_idx
  on public.upload_processing_jobs(session_id, created_at);

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
  select * into session_row
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
  select * into session_row
  from public.upload_sessions
  where id = target_session_id and user_id = target_user_id
  for update;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'upload_session_not_active';
  end if;

  select * into file_row
  from public.upload_session_files
  where id = target_file_id and session_id = target_session_id
  for update;

  if file_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_file_not_found';
  end if;
  if file_row.status not in ('uploaded', 'processing', 'completed') then
    raise exception using errcode = 'P0001', message = 'upload_session_file_not_ready';
  end if;

  insert into public.upload_processing_jobs (session_id, file_id, user_id)
  values (target_session_id, target_file_id, target_user_id)
  on conflict (file_id) do update set file_id = excluded.file_id
  returning id into processing_job_id;

  return processing_job_id;
end;
$$;

create or replace function public.queue_upload_session_processing(
  target_session_id uuid,
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending_file_count integer;
  processable_file_count integer;
  processing_job_id uuid;
begin
  perform 1
  from public.upload_sessions
  where id = target_session_id and user_id = target_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;

  select
    count(*) filter (where status in ('pending_upload', 'verifying')),
    count(*) filter (where status in ('uploaded', 'processing', 'completed'))
    into pending_file_count, processable_file_count
  from public.upload_session_files
  where session_id = target_session_id;

  if pending_file_count > 0 then
    raise exception using errcode = 'P0001', message = 'upload_session_incomplete';
  end if;
  if processable_file_count < 1 then
    raise exception using errcode = 'P0001', message = 'upload_session_has_no_processable_files';
  end if;

  insert into public.upload_processing_jobs (session_id, file_id, user_id)
  select target_session_id, file.id, target_user_id
  from public.upload_session_files file
  where file.session_id = target_session_id and file.status = 'uploaded'
  on conflict (file_id) do nothing;

  select id into processing_job_id
  from public.upload_processing_jobs
  where session_id = target_session_id
  order by created_at
  limit 1;

  perform public.refresh_upload_session_status(target_session_id);
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
    and ((status = 'queued' and available_at <= now())
      or (status = 'running'
        and locked_at <= now() - make_interval(secs => target_lease_seconds)))
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

revoke all on function public.refresh_upload_session_status(uuid)
  from public, anon, authenticated;
revoke all on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.queue_upload_session_processing(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_upload_processing_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.refresh_upload_session_status(uuid)
  to service_role;
grant execute on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  to service_role;
grant execute on function public.queue_upload_session_processing(uuid, uuid)
  to service_role;
grant execute on function public.claim_upload_processing_job(text, integer)
  to service_role;

insert into public.upload_processing_jobs (session_id, file_id, user_id)
select file.session_id, file.id, session.user_id
from public.upload_session_files file
join public.upload_sessions session on session.id = file.session_id
where file.status = 'uploaded'
on conflict (file_id) do nothing;

do $$
declare
  current_session_id uuid;
begin
  for current_session_id in
    select distinct file.session_id
    from public.upload_session_files file
    where file.status in ('uploaded', 'completed', 'error')
  loop
    perform public.refresh_upload_session_status(current_session_id);
  end loop;
end;
$$;

commit;
