-- Migration date: 2026-09-05

-- Private, scoped memory is stored as immutable Markdown objects. Postgres
-- owns only the current-version pointer, audit metadata, enablement epoch, and
-- durable curator scheduling state. The epoch fences workers that were queued
-- before a destructive disable or wipe.

alter table public.chat_messages
  add column if not exists author_user_id uuid references auth.users(id) on delete set null;
alter table public.word_chat_messages
  add column if not exists author_user_id uuid references auth.users(id) on delete set null;
alter table public.tabular_review_chat_messages
  add column if not exists author_user_id uuid references auth.users(id) on delete set null;
alter table public.chat_messages
  add column if not exists memory_input_message_id uuid,
  add column if not exists memory_eligible_at timestamptz;
alter table public.word_chat_messages
  add column if not exists memory_input_message_id uuid,
  add column if not exists memory_eligible_at timestamptz;
alter table public.tabular_review_chat_messages
  add column if not exists memory_input_message_id uuid,
  add column if not exists memory_eligible_at timestamptz;

create index if not exists chat_messages_chat_created_id_idx
  on public.chat_messages(chat_id, created_at, id);
create index if not exists chat_messages_author_idx
  on public.chat_messages(author_user_id) where author_user_id is not null;
create index if not exists word_chat_messages_author_idx
  on public.word_chat_messages(author_user_id) where author_user_id is not null;
create index if not exists tabular_review_chat_messages_author_idx
  on public.tabular_review_chat_messages(author_user_id) where author_user_id is not null;

create table if not exists public.memory_files (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('user', 'project')),
  user_id uuid references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  enabled boolean not null default true,
  epoch bigint not null default 0 check (epoch >= 0),
  version bigint not null default 0 check (version >= 0),
  learning_cutoff_at timestamptz not null default now(),
  current_version_id uuid,
  status text not null default 'idle'
    check (status in ('idle', 'scheduled', 'processing', 'failed')),
  last_error_code text,
  last_source text check (
    last_source is null or last_source in ('manual', 'curator', 'restore', 'wipe', 'settings')
  ),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_files_scope_owner_check check (
    (scope = 'user' and user_id is not null and project_id is null)
    or (scope = 'project' and project_id is not null and user_id is null)
  )
);

create unique index if not exists memory_files_user_unique
  on public.memory_files(user_id);
create unique index if not exists memory_files_project_unique
  on public.memory_files(project_id);
create index if not exists memory_files_current_version_idx
  on public.memory_files(current_version_id) where current_version_id is not null;

alter table public.memory_files
  add column if not exists learning_cutoff_at timestamptz not null default now(),
  add column if not exists last_source text;

create table if not exists public.memory_file_versions (
  id uuid primary key,
  memory_file_id uuid not null references public.memory_files(id) on delete cascade,
  version bigint not null check (version > 0),
  storage_path text not null unique,
  size_bytes integer not null check (size_bytes >= 0 and size_bytes <= 16384),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('manual', 'curator', 'restore')),
  change_summary text check (
    change_summary is null or char_length(change_summary) <= 500
  ),
  updated_by uuid references auth.users(id) on delete set null,
  model text,
  source_surface text check (
    source_surface is null or source_surface in ('chat', 'word', 'tabular')
  ),
  source_chat_id uuid,
  source_turn_id uuid,
  source_job_id uuid,
  created_at timestamptz not null default now(),
  unique(memory_file_id, version),
  unique(memory_file_id, source_job_id)
);

create index if not exists memory_file_versions_file_created_idx
  on public.memory_file_versions(memory_file_id, created_at desc);

alter table public.memory_file_versions
  add column if not exists change_summary text;

-- A durable pointer exists before every object upload. Promotion removes it
-- only after the immutable version row is committed; crashes leave a delayed
-- cleanup job with enough information to reclaim the staging object.
create table if not exists public.memory_object_candidates (
  id uuid primary key,
  memory_file_id uuid references public.memory_files(id) on delete set null,
  scope text not null check (scope in ('user', 'project')),
  owner_id uuid not null,
  epoch bigint not null check (epoch >= 0),
  storage_path text not null unique,
  status text not null default 'uploading'
    check (status in ('uploading', 'abandoned', 'cleaning')),
  cleanup_job_id uuid not null unique,
  cleanup_after timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists memory_object_candidates_file_idx
  on public.memory_object_candidates(memory_file_id);
create index if not exists memory_object_candidates_cleanup_idx
  on public.memory_object_candidates(cleanup_after);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_files_current_version_id_fkey'
      and conrelid = 'public.memory_files'::regclass
  ) then
    alter table public.memory_files
      add constraint memory_files_current_version_id_fkey
      foreign key (current_version_id)
      references public.memory_file_versions(id)
      on delete set null
      deferrable initially deferred;
  end if;
end;
$$;

create table if not exists public.memory_consolidation_states (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('chat', 'word', 'tabular')),
  conversation_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  processed_generation bigint not null default 0 check (processed_generation >= 0),
  latest_activity_id uuid,
  conversation_generation bigint not null default 0
    check (conversation_generation >= 0),
  source_epoch bigint not null default 0 check (source_epoch >= 0),
  latest_turn_id uuid,
  latest_terminal_at timestamptz,
  latest_terminal_message_at timestamptz,
  run_after timestamptz,
  status text not null default 'idle'
    check (status in ('idle', 'scheduled', 'processing', 'failed', 'disabled')),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(surface, conversation_id, actor_user_id)
);

create index if not exists memory_consolidation_states_project_idx
  on public.memory_consolidation_states(project_id) where project_id is not null;

alter table public.memory_consolidation_states
  add column if not exists latest_activity_id uuid,
  add column if not exists conversation_generation bigint not null default 0,
  add column if not exists source_epoch bigint not null default 0,
  add column if not exists latest_terminal_at timestamptz,
  add column if not exists latest_terminal_message_at timestamptz;

alter table public.memory_consolidation_states
  alter column actor_user_id set not null;
alter table public.memory_consolidation_states
  drop constraint if exists memory_consolidation_states_actor_user_id_fkey;
alter table public.memory_consolidation_states
  add constraint memory_consolidation_states_actor_user_id_fkey
  foreign key (actor_user_id) references auth.users(id) on delete cascade;

create table if not exists public.memory_conversation_activity (
  surface text not null check (surface in ('chat', 'word', 'tabular')),
  conversation_id uuid not null,
  generation bigint not null default 0 check (generation >= 0),
  source_epoch bigint not null default 0 check (source_epoch >= 0),
  latest_activity_id uuid,
  latest_turn_id uuid,
  latest_turn_message_at timestamptz,
  latest_turn_completed_at timestamptz,
  latest_turn_actor_user_id uuid references auth.users(id) on delete set null,
  project_id uuid,
  project_curator_actor_user_id uuid references auth.users(id) on delete set null,
  quiet_until timestamptz,
  actor_user_id uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(surface, conversation_id)
);

alter table public.memory_conversation_activity
  add column if not exists source_epoch bigint not null default 0,
  add column if not exists latest_activity_id uuid,
  add column if not exists latest_turn_message_at timestamptz,
  add column if not exists latest_turn_completed_at timestamptz,
  add column if not exists latest_turn_actor_user_id uuid references auth.users(id) on delete set null,
  add column if not exists project_id uuid,
  add column if not exists project_curator_actor_user_id uuid references auth.users(id) on delete set null,
  add column if not exists quiet_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.memory_conversation_activity
  drop column if exists active_turn_id,
  drop column if exists active_until;

alter table public.memory_conversation_activity
  alter column actor_user_id drop not null;
alter table public.memory_conversation_activity
  drop constraint if exists memory_conversation_activity_actor_user_id_fkey;
alter table public.memory_conversation_activity
  add constraint memory_conversation_activity_actor_user_id_fkey
  foreign key (actor_user_id) references auth.users(id) on delete set null;

create table if not exists public.memory_conversation_turn_leases (
  surface text not null check (surface in ('chat', 'word', 'tabular')),
  conversation_id uuid not null,
  activity_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(surface, conversation_id, activity_id)
);

create index if not exists memory_conversation_turn_leases_expiry_idx
  on public.memory_conversation_turn_leases(expires_at);

create table if not exists public.memory_consolidation_results (
  job_id uuid not null,
  memory_file_id uuid not null references public.memory_files(id) on delete cascade,
  scope text not null check (scope in ('user', 'project')),
  outcome text not null check (
    outcome in ('updated', 'no_change', 'skipped', 'superseded')
  ),
  version bigint,
  created_at timestamptz not null default now(),
  primary key(job_id, memory_file_id)
);

alter table public.memory_files enable row level security;
alter table public.memory_file_versions enable row level security;
alter table public.memory_object_candidates enable row level security;
alter table public.memory_consolidation_states enable row level security;
alter table public.memory_conversation_activity enable row level security;
alter table public.memory_conversation_turn_leases enable row level security;
alter table public.memory_consolidation_results enable row level security;

-- Existing accounts and projects start opted out. The trigger below explicitly
-- enables each newly created account; new project creation writes its explicit
-- setting in the same application transaction.
insert into public.memory_files(scope, user_id, enabled)
select 'user', id, false from auth.users
on conflict do nothing;

insert into public.memory_files(scope, project_id, enabled)
select 'project', id, false from public.projects
on conflict do nothing;

create or replace function public.initialize_new_user_memory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.memory_files(scope, user_id, enabled)
  values ('user', new.id, true)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_memory on auth.users;
create trigger on_auth_user_created_memory
  after insert on auth.users
  for each row execute function public.initialize_new_user_memory();

create or replace function public.create_project_with_memory(
  p_user_id uuid,
  p_name text,
  p_cm_number text,
  p_practice text,
  p_org_id uuid,
  p_memory_enabled boolean
)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  created public.projects%rowtype;
begin
  insert into public.projects(user_id, name, cm_number, practice, org_id)
  values (p_user_id, p_name, p_cm_number, p_practice, p_org_id)
  returning * into created;
  insert into public.memory_files(scope, project_id, enabled)
  values ('project', created.id, p_memory_enabled);
  return created;
end;
$$;

-- Remove the superseded pre-stream activity API so it cannot be called out of band.
drop function if exists public.invalidate_memory_conversation(
  text, uuid, uuid, uuid, uuid
);

create or replace function public.lock_memory_conversation_source(
  p_surface text,
  p_conversation_id uuid,
  p_actor_user_id uuid
)
returns table(locked_project_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_user_id uuid;
  resolved_project_id uuid;
  verified_owner_user_id uuid;
  verified_project_id uuid;
  review_id uuid;
  verified_review_id uuid;
  word_document_id uuid;
  verified_word_document_id uuid;
begin
  if p_surface = 'chat' then
    select source.user_id, source.project_id
    into owner_user_id, resolved_project_id
    from public.chats source where source.id = p_conversation_id;
    if not found then return; end if;
    perform actor.id from auth.users actor
    where actor.id in (p_actor_user_id, owner_user_id)
    order by actor.id for key share;
    if resolved_project_id is not null then
      perform project.id from public.projects project
      where project.id = resolved_project_id for key share;
      if not found then return; end if;
    end if;
    select source.user_id, source.project_id
    into verified_owner_user_id, verified_project_id
    from public.chats source
    where source.id = p_conversation_id for key share;
    if not found
      or verified_owner_user_id is distinct from owner_user_id
      or verified_project_id is distinct from resolved_project_id
    then
      raise exception using errcode = '40001', message = 'memory_source_changed';
    end if;
  elsif p_surface = 'word' then
    select source.user_id, source.word_document_id
    into owner_user_id, word_document_id
    from public.word_chats source where source.id = p_conversation_id;
    if not found then return; end if;
    perform actor.id from auth.users actor
    where actor.id in (p_actor_user_id, owner_user_id)
    order by actor.id for key share;
    perform document.id from public.word_documents document
    where document.id = word_document_id for key share;
    if not found then return; end if;
    select source.user_id, source.word_document_id
    into verified_owner_user_id, verified_word_document_id
    from public.word_chats source
    where source.id = p_conversation_id for key share;
    if not found
      or verified_owner_user_id is distinct from owner_user_id
      or verified_word_document_id is distinct from word_document_id
    then
      raise exception using errcode = '40001', message = 'memory_source_changed';
    end if;
    resolved_project_id := null;
  elsif p_surface = 'tabular' then
    select source.user_id, source.review_id, review.user_id, review.project_id
    into owner_user_id, review_id, verified_owner_user_id, resolved_project_id
    from public.tabular_review_chats source
    join public.tabular_reviews review on review.id = source.review_id
    where source.id = p_conversation_id;
    if not found then return; end if;
    perform actor.id from auth.users actor
    where actor.id in (p_actor_user_id, owner_user_id, verified_owner_user_id)
    order by actor.id for key share;
    if resolved_project_id is not null then
      perform project.id from public.projects project
      where project.id = resolved_project_id for key share;
      if not found then return; end if;
    end if;
    perform review.id from public.tabular_reviews review
    where review.id = review_id for key share;
    if not found then return; end if;
    select source.user_id, source.review_id, review.user_id, review.project_id
    into verified_owner_user_id, verified_review_id,
      owner_user_id, verified_project_id
    from public.tabular_review_chats source
    join public.tabular_reviews review on review.id = source.review_id
    where source.id = p_conversation_id for key share of source, review;
    if not found
      or verified_review_id is distinct from review_id
      or verified_project_id is distinct from resolved_project_id
    then
      raise exception using errcode = '40001', message = 'memory_source_changed';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_memory_surface';
  end if;
  return query select resolved_project_id;
end;
$$;

drop function if exists public.begin_memory_conversation_turn(
  text, uuid, uuid, uuid, timestamptz
);
create or replace function public.begin_memory_conversation_turn(
  p_surface text,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_activity_id uuid,
  p_lease_seconds integer,
  p_quiet_seconds integer
)
returns table(conversation_generation bigint, source_epoch bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  activity public.memory_conversation_activity%rowtype;
  lease_until timestamptz;
  minimum_quiet_until timestamptz;
begin
  if p_surface not in ('chat', 'word', 'tabular')
    or p_activity_id is null
    or p_lease_seconds < 60 or p_lease_seconds > 14400
    or p_quiet_seconds < 1 or p_quiet_seconds > 3600
  then
    raise exception using errcode = '22023', message = 'invalid_memory_activity';
  end if;
  lease_until := now() + make_interval(secs => p_lease_seconds);
  minimum_quiet_until := now() + make_interval(secs => p_quiet_seconds);

  -- Every mutation that can race source deletion starts with the canonical
  -- source row. The DELETE trigger therefore either fences this transaction
  -- before it creates scheduler metadata or runs after this transaction ends.
  perform locked.locked_project_id
  from public.lock_memory_conversation_source(
    p_surface, p_conversation_id, p_actor_user_id
  ) locked;
  if not found then
    raise exception using errcode = '40001', message = 'memory_conversation_deleted';
  end if;

  insert into public.memory_conversation_activity(
    surface, conversation_id, actor_user_id, quiet_until
  ) values (
    p_surface, p_conversation_id, p_actor_user_id, minimum_quiet_until
  ) on conflict (surface, conversation_id) do nothing;
  select * into activity from public.memory_conversation_activity
  where surface = p_surface and conversation_id = p_conversation_id for update;
  if activity.deleted_at is not null then
    raise exception using errcode = '40001', message = 'memory_conversation_deleted';
  end if;

  delete from public.memory_conversation_turn_leases
  where surface = p_surface and conversation_id = p_conversation_id
    and expires_at <= now();
  insert into public.memory_conversation_turn_leases(
    surface, conversation_id, activity_id, actor_user_id, expires_at
  ) values (
    p_surface, p_conversation_id, p_activity_id, p_actor_user_id, lease_until
  ) on conflict (surface, conversation_id, activity_id) do update
    set actor_user_id = excluded.actor_user_id,
        expires_at = greatest(
          public.memory_conversation_turn_leases.expires_at,
          excluded.expires_at
        );

  update public.memory_conversation_activity
  set quiet_until = greatest(
        coalesce(quiet_until, '-infinity'::timestamptz),
        minimum_quiet_until
      ),
      actor_user_id = p_actor_user_id,
      updated_at = now()
  where surface = p_surface and conversation_id = p_conversation_id;

  -- A claimed worker is fenced again during promotion. Pending work is moved
  -- only a short interval so a crashed stream is retried until its lease dies.
  update public.db_jobs
  set run_at = greatest(
        run_at,
        least(lease_until, now() + interval '1 minute')
      )
  where kind = 'memory.consolidate' and status = 'pending'
    and payload->>'surface' = p_surface
    and payload->>'conversationId' = p_conversation_id::text;
  update public.memory_consolidation_states
  set run_after = greatest(
        coalesce(run_after, '-infinity'::timestamptz),
        least(lease_until, now() + interval '1 minute')
      ),
      updated_at = now()
  where surface = p_surface and conversation_id = p_conversation_id
    and processed_generation < generation;

  return query select activity.generation, activity.source_epoch;
end;
$$;

drop function if exists public.release_memory_conversation_turn(
  text, uuid, uuid, timestamptz
);
create or replace function public.release_memory_conversation_turn(
  p_surface text,
  p_conversation_id uuid,
  p_activity_id uuid,
  p_quiet_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  activity public.memory_conversation_activity%rowtype;
  next_quiet_until timestamptz;
begin
  if p_surface not in ('chat', 'word', 'tabular')
    or p_activity_id is null
    or p_quiet_seconds < 1 or p_quiet_seconds > 3600
  then
    raise exception using errcode = '22023', message = 'invalid_memory_activity';
  end if;
  next_quiet_until := now() + make_interval(secs => p_quiet_seconds);
  select * into activity from public.memory_conversation_activity
  where surface = p_surface and conversation_id = p_conversation_id for update;
  if not found or activity.deleted_at is not null then return false; end if;
  delete from public.memory_conversation_turn_leases
  where surface = p_surface and conversation_id = p_conversation_id
    and activity_id = p_activity_id;
  if not found then return false; end if;

  update public.memory_conversation_activity
  set quiet_until = greatest(
        coalesce(quiet_until, '-infinity'::timestamptz),
        next_quiet_until
      ),
      updated_at = now()
  where surface = p_surface and conversation_id = p_conversation_id;
  update public.db_jobs
  set run_at = greatest(run_at, next_quiet_until)
  where kind = 'memory.consolidate' and status = 'pending'
    and payload->>'surface' = p_surface
    and payload->>'conversationId' = p_conversation_id::text;
  update public.memory_consolidation_states as pending
  set run_after = greatest(
        coalesce(pending.run_after, '-infinity'::timestamptz),
        next_quiet_until
      ),
      status = case
        when pending.processed_generation < pending.generation
          then 'scheduled'
        else pending.status
      end,
      updated_at = now()
  where pending.surface = p_surface
    and pending.conversation_id = p_conversation_id;
  return true;
end;
$$;

create or replace function public.fence_memory_conversation_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fence_surface text := tg_argv[0];
begin
  if fence_surface not in ('chat', 'word', 'tabular') then
    raise exception using errcode = '22023', message = 'invalid_memory_surface';
  end if;

  -- DELETE already owns the canonical source row. Follow the global
  -- source -> activity -> lease -> state order used by scheduling/promotion.
  update public.memory_conversation_activity
  set source_epoch = source_epoch + 1,
      generation = generation + 1,
      latest_activity_id = null,
      latest_turn_id = null,
      quiet_until = null,
      deleted_at = now(),
      updated_at = now()
  where surface = fence_surface and conversation_id = old.id;
  delete from public.memory_conversation_turn_leases
  where surface = fence_surface and conversation_id = old.id;
  update public.memory_consolidation_states as rearmed
  set generation = rearmed.generation + 1,
      latest_activity_id = null,
      latest_turn_id = null,
      status = 'idle',
      updated_at = now()
  where surface = fence_surface and conversation_id = old.id;
  update public.db_jobs
  set run_at = least(run_at, now())
  where kind = 'memory.consolidate'
    and status = 'pending'
    and payload->>'surface' = fence_surface
    and payload->>'conversationId' = old.id::text;
  delete from public.memory_consolidation_states
  where surface = fence_surface and conversation_id = old.id;
  delete from public.memory_conversation_activity
  where surface = fence_surface and conversation_id = old.id;
  return old;
end;
$$;

drop trigger if exists chats_memory_delete_fence on public.chats;
create trigger chats_memory_delete_fence
before delete on public.chats
for each row execute function public.fence_memory_conversation_delete('chat');
drop trigger if exists word_chats_memory_delete_fence on public.word_chats;
create trigger word_chats_memory_delete_fence
before delete on public.word_chats
for each row execute function public.fence_memory_conversation_delete('word');
drop trigger if exists tabular_review_chats_memory_delete_fence
  on public.tabular_review_chats;
create trigger tabular_review_chats_memory_delete_fence
before delete on public.tabular_review_chats
for each row execute function public.fence_memory_conversation_delete('tabular');

create index if not exists db_jobs_memory_conversation_pending_idx
  on public.db_jobs((payload->>'surface'), (payload->>'conversationId'))
  where kind = 'memory.consolidate' and status = 'pending';

create or replace function public.fence_memory_file_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  committed_paths text[];
  candidate_cleanup_time timestamptz := now() + interval '1 hour';
begin
  select coalesce(array_agg(distinct version.storage_path), '{}'::text[])
  into committed_paths
  from public.memory_file_versions version
  where version.memory_file_id = old.id;
  if cardinality(committed_paths) > 0 then
    insert into public.db_jobs(kind, payload, max_attempts, dedupe_key)
    values (
      'storage.cleanup',
      jsonb_build_object(
        'keys', to_jsonb(committed_paths), 'prefixes', '[]'::jsonb
      ),
      2147483647,
      'memory-file-delete:' || old.id::text || ':' || old.epoch::text
    ) on conflict do nothing;
  end if;
  with abandoned as (
    update public.memory_object_candidates
    set status = 'abandoned',
        cleanup_after = greatest(cleanup_after, candidate_cleanup_time)
    where memory_file_id = old.id
      and status in ('uploading', 'abandoned')
    returning cleanup_job_id
  )
  update public.db_jobs
  set run_at = greatest(run_at, candidate_cleanup_time)
  where id in (select cleanup_job_id from abandoned)
    and status = 'pending';
  return old;
end;
$$;

drop trigger if exists memory_files_delete_fence on public.memory_files;
create trigger memory_files_delete_fence
before delete on public.memory_files
for each row execute function public.fence_memory_file_delete();

-- Memory Markdown deletion jobs are durable object pointers. They must remain
-- automatically retryable even if a worker dies after claiming one: treating
-- an over-budget stale claim as terminal would preserve the row but strand the
-- private object forever. Existing failed cleanup rows are revived as part of
-- the same batch-claim path so upgrades repair that state automatically.
create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
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
       and kind not in ('storage.cleanup', 'memory.candidate_cleanup')
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'failed'
            and kind in ('storage.cleanup', 'memory.candidate_cleanup'))
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind in ('storage.cleanup', 'memory.candidate_cleanup')
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
           when j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then null
           else j.dedupe_key
         end
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then 2147483647
           else j.max_attempts
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
             then null
           else j.dedupe_key
         end
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'failed'
           and j.kind in ('storage.cleanup', 'memory.candidate_cleanup'))
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and (
             j.attempts < j.max_attempts
             or j.kind in ('storage.cleanup', 'memory.candidate_cleanup')
           )))
  returning j.*;
$$;

create index if not exists db_jobs_failed_cleanup_run_at_idx
  on public.db_jobs(run_at)
  where status = 'failed'
    and kind in ('storage.cleanup', 'memory.candidate_cleanup');

create or replace function public.begin_memory_file_upload(
  p_memory_file_id uuid,
  p_expected_version bigint,
  p_expected_epoch bigint,
  p_candidate_id uuid,
  p_storage_path text
)
returns table(candidate_id uuid, cleanup_job_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  cleanup_id uuid := gen_random_uuid();
  cleanup_time timestamptz := now() + interval '1 hour';
begin
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;
  if not target.enabled then
    raise exception using errcode = 'P0001', message = 'memory_disabled';
  end if;
  if target.epoch <> p_expected_epoch then
    raise exception using errcode = '40001', message = 'memory_epoch_conflict';
  end if;
  if target.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'memory_version_conflict';
  end if;
  insert into public.memory_object_candidates(
    id, memory_file_id, scope, owner_id, epoch, storage_path,
    cleanup_job_id, cleanup_after
  ) values (
    p_candidate_id, target.id, target.scope,
    coalesce(target.user_id, target.project_id), target.epoch, p_storage_path,
    cleanup_id, cleanup_time
  );
  insert into public.db_jobs(
    id, kind, payload, max_attempts, run_at, dedupe_key
  ) values (
    cleanup_id, 'memory.candidate_cleanup',
    jsonb_build_object('candidateId', p_candidate_id),
    2147483647, cleanup_time, 'memory-candidate:' || p_candidate_id::text
  );
  return query select p_candidate_id, cleanup_id;
end;
$$;

create or replace function public.claim_memory_upload_candidate(
  p_candidate_id uuid
)
returns table(claim_status text, candidate_storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate public.memory_object_candidates%rowtype;
begin
  select * into candidate from public.memory_object_candidates
  where id = p_candidate_id for update;
  if not found then
    return query select 'missing'::text, null::text;
    return;
  end if;
  if candidate.cleanup_after > now() then
    return query select 'not_due'::text, null::text;
    return;
  end if;
  update public.memory_object_candidates
  set status = 'cleaning'
  where id = candidate.id;
  return query select 'claimed'::text, candidate.storage_path;
end;
$$;

drop function if exists public.advance_memory_file(
  uuid, bigint, bigint, uuid, uuid, text, integer, text, text, uuid, text,
  text, uuid, uuid, uuid, uuid, bigint, bigint
);
drop function if exists public.advance_memory_file(
  uuid, bigint, bigint, uuid, uuid, text, integer, text, text, uuid, text,
  text, uuid, uuid, uuid, uuid, bigint, bigint, bigint
);
drop function if exists public.advance_memory_file(
  uuid, bigint, bigint, uuid, uuid, text, integer, text, text, text, uuid,
  text, text, uuid, uuid, uuid, uuid, bigint, bigint, bigint
);

create or replace function public.advance_memory_file(
  p_memory_file_id uuid,
  p_expected_version bigint,
  p_expected_epoch bigint,
  p_version_id uuid,
  p_candidate_id uuid,
  p_storage_path text,
  p_size_bytes integer,
  p_content_sha256 text,
  p_source text,
  p_change_summary text default null,
  p_updated_by uuid default null,
  p_model text default null,
  p_source_surface text default null,
  p_source_chat_id uuid default null,
  p_source_turn_id uuid default null,
  p_source_job_id uuid default null,
  p_consolidation_state_id uuid default null,
  p_consolidation_generation bigint default null,
  p_conversation_generation bigint default null,
  p_source_epoch bigint default null
)
returns table(applied boolean, new_version bigint, current_version_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  existing public.memory_file_versions%rowtype;
  consolidation public.memory_consolidation_states%rowtype;
  activity public.memory_conversation_activity%rowtype;
  candidate public.memory_object_candidates%rowtype;
  stale_ids uuid[];
  stale_paths text[];
begin
  if p_change_summary is not null and char_length(p_change_summary) > 500 then
    raise exception using errcode = '22023', message = 'memory_change_summary_too_long';
  end if;
  -- Match canonical DELETE's source -> scheduler-state lock order. Holding
  -- this key-share lock through version promotion makes deletion and learning
  -- serialize without a check/write gap.
  if p_source = 'curator' then
    if p_consolidation_state_id is null
      or p_consolidation_generation is null
      or p_conversation_generation is null
      or p_source_surface is null
      or p_source_chat_id is null
      or p_source_epoch is null
    then
      raise exception using errcode = '22023', message = 'memory_curator_fence_required';
    end if;
    perform locked.locked_project_id
    from public.lock_memory_conversation_source(
      p_source_surface, p_source_chat_id, p_updated_by
    ) locked;
    if not found then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
    select * into activity from public.memory_conversation_activity
    where surface = p_source_surface and conversation_id = p_source_chat_id
    for update;
    if not found
      or activity.deleted_at is not null
      or activity.source_epoch <> p_source_epoch
      or activity.generation <> p_conversation_generation
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
    if activity.quiet_until is null
      or activity.quiet_until > now()
      or exists (
        select 1 from public.memory_conversation_turn_leases lease
        where lease.surface = p_source_surface
          and lease.conversation_id = p_source_chat_id
          and lease.expires_at > now()
      )
    then
      raise exception using errcode = '55000', message = 'memory_conversation_not_quiet';
    end if;
    select * into consolidation from public.memory_consolidation_states
    where id = p_consolidation_state_id for update;
    if not found
      or consolidation.generation <> p_consolidation_generation
      or consolidation.conversation_generation <> p_conversation_generation
      or consolidation.surface <> p_source_surface
      or consolidation.conversation_id <> p_source_chat_id
      or consolidation.source_epoch <> p_source_epoch
      or consolidation.actor_user_id is distinct from p_updated_by
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
  end if;

  select * into target from public.memory_files
  where id = p_memory_file_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  if p_source_job_id is not null then
    select * into existing from public.memory_file_versions
    where memory_file_id = p_memory_file_id
      and source_job_id = p_source_job_id;
    if found then
      return query select false, existing.version, existing.id;
      return;
    end if;
  end if;

  if p_source = 'curator' then
    if (target.scope = 'user' and target.user_id <> consolidation.actor_user_id)
      or (target.scope = 'project' and target.project_id is distinct from consolidation.project_id)
    then
      raise exception using errcode = '40001', message = 'memory_job_superseded';
    end if;
  end if;

  if not target.enabled then
    raise exception using errcode = 'P0001', message = 'memory_disabled';
  end if;
  if target.epoch <> p_expected_epoch then
    raise exception using errcode = '40001', message = 'memory_epoch_conflict';
  end if;
  if target.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'memory_version_conflict';
  end if;
  select * into candidate from public.memory_object_candidates
  where id = p_candidate_id for update;
  if not found
    or candidate.memory_file_id <> target.id
    or candidate.epoch <> p_expected_epoch
    or candidate.storage_path <> p_storage_path
    or candidate.status <> 'uploading'
  then
    raise exception using errcode = '40001', message = 'memory_candidate_conflict';
  end if;

  insert into public.memory_file_versions(
    id, memory_file_id, version, storage_path, size_bytes, content_sha256,
    source, change_summary, updated_by, model, source_surface, source_chat_id,
    source_turn_id, source_job_id
  ) values (
    p_version_id, p_memory_file_id, target.version + 1, p_storage_path,
    p_size_bytes, p_content_sha256, p_source, p_change_summary, p_updated_by, p_model,
    p_source_surface, p_source_chat_id, p_source_turn_id, p_source_job_id
  );

  update public.memory_files
  set version = target.version + 1,
      current_version_id = p_version_id,
      last_error_code = null,
      last_source = p_source,
      updated_by = p_updated_by,
      updated_at = now()
  where id = p_memory_file_id;

  delete from public.memory_object_candidates where id = candidate.id;

  -- Retention and cleanup are one transaction: storage paths remain durable
  -- until a cleanup job exists, and a worker cannot observe that job until
  -- the stale metadata has been removed by the same commit.
  select
    coalesce(array_agg(stale.id), '{}'::uuid[]),
    coalesce(array_agg(stale.storage_path), '{}'::text[])
  into stale_ids, stale_paths
  from (
    select id, storage_path
    from public.memory_file_versions
    where memory_file_id = p_memory_file_id
    order by version desc
    offset 50
  ) stale;
  if cardinality(stale_ids) > 0 then
    insert into public.db_jobs(kind, payload, max_attempts, dedupe_key)
    values (
      'storage.cleanup',
      jsonb_build_object('keys', to_jsonb(stale_paths), 'prefixes', '[]'::jsonb),
      2147483647,
      'memory-prune:' || p_memory_file_id::text || ':' || (target.version + 1)::text
    );
    delete from public.memory_file_versions where id = any(stale_ids);
  end if;

  if p_source_job_id is not null then
    insert into public.memory_consolidation_results(
      job_id, memory_file_id, scope, outcome, version
    ) values (
      p_source_job_id, target.id, target.scope, 'updated', target.version + 1
    ) on conflict (job_id, memory_file_id) do update
      set outcome = excluded.outcome,
          version = excluded.version,
          created_at = now();
  end if;

  return query select true, target.version + 1, p_version_id;
end;
$$;

drop function if exists public.wipe_memory_file(uuid, boolean);
drop function if exists public.wipe_memory_file(uuid, boolean, uuid, text);
create or replace function public.wipe_memory_file(
  p_memory_file_id uuid,
  p_enabled boolean,
  p_updated_by uuid default null,
  p_source text default 'wipe',
  p_require_no_candidates boolean default false
)
returns table(
  storage_paths text[],
  new_epoch bigint,
  new_version bigint,
  effective_enabled boolean,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  paths text[];
  candidate_job_ids uuid[];
  candidate_cleanup_after timestamptz := now() + interval '1 hour';
begin
  if p_source not in ('wipe', 'settings') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;
  if p_require_no_candidates and exists (
    select 1 from public.memory_object_candidates
    where memory_file_id = target.id
  ) then
    raise exception using errcode = '55000', message = 'memory_cleanup_pending';
  end if;

  select coalesce(array_agg(storage_path), '{}'::text[]) into paths
  from public.memory_file_versions where memory_file_id = target.id;

  with abandoned as (
    update public.memory_object_candidates
    set status = 'abandoned',
        cleanup_after = greatest(cleanup_after, candidate_cleanup_after)
    where memory_file_id = target.id
      and status in ('uploading', 'abandoned')
    returning cleanup_job_id
  )
  select coalesce(array_agg(cleanup_job_id), '{}'::uuid[])
  into candidate_job_ids from abandoned;
  if cardinality(candidate_job_ids) > 0 then
    update public.db_jobs
    set run_at = greatest(run_at, candidate_cleanup_after)
    where id = any(candidate_job_ids) and status = 'pending';
  end if;

  -- Never remove the only durable pointers to the objects until their cleanup
  -- is itself durable. The job cannot be claimed until this transaction commits.
  if cardinality(paths) > 0 then
    insert into public.db_jobs(kind, payload, max_attempts, dedupe_key)
    values (
      'storage.cleanup',
      jsonb_build_object('keys', to_jsonb(paths), 'prefixes', '[]'::jsonb),
      2147483647,
      'memory-wipe:' || target.id::text || ':' || (target.epoch + 1)::text
    );
  end if;

  update public.memory_files
  set enabled = coalesce(p_enabled, target.enabled),
      epoch = target.epoch + 1,
      version = target.version + 1,
      learning_cutoff_at = now(),
      current_version_id = null,
      status = 'idle',
      last_error_code = null,
      last_source = p_source,
      updated_by = p_updated_by,
      updated_at = now()
  where id = target.id;

  delete from public.memory_file_versions where memory_file_id = target.id;

  return query select
    paths,
    target.epoch + 1,
    target.version + 1,
    coalesce(p_enabled, target.enabled),
    now(),
    p_updated_by;
end;
$$;

create or replace function public.enable_memory_file(
  p_memory_file_id uuid,
  p_updated_by uuid
)
returns table(
  effective_enabled boolean,
  new_epoch bigint,
  new_version bigint,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  changed_at timestamptz := now();
begin
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;
  if target.enabled then
    return query select true, target.epoch, target.version,
      target.updated_at, target.updated_by;
    return;
  end if;
  update public.memory_files memory_file
  set enabled = true,
      epoch = target.epoch + 1,
      version = target.version + 1,
      learning_cutoff_at = changed_at,
      status = 'idle',
      last_error_code = null,
      last_source = 'settings',
      updated_by = p_updated_by,
      updated_at = changed_at
  where memory_file.id = target.id;
  return query select true, target.epoch + 1, target.version + 1,
    changed_at, p_updated_by;
end;
$$;

-- Remove superseded scheduler overloads before installing the final API.
drop function if exists public.schedule_memory_consolidation(
  text, uuid, uuid, uuid, uuid, timestamptz
);
drop function if exists public.schedule_memory_consolidation(
  text, uuid, uuid, uuid, uuid, uuid, timestamptz
);
create or replace function public.schedule_memory_consolidation(
  p_surface text,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_project_id uuid,
  p_turn_id uuid,
  p_activity_id uuid,
  p_quiet_seconds integer
)
returns table(job_id uuid, generation bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.memory_consolidation_states%rowtype;
  activity public.memory_conversation_activity%rowtype;
  queued_state public.memory_consolidation_states%rowtype;
  app_file public.memory_files%rowtype;
  project_file public.memory_files%rowtype;
  canonical_project_id uuid;
  terminal_message_at timestamptz;
  terminal_at timestamptz := now();
  next_quiet_until timestamptz;
  next_conversation_generation bigint;
  actor_generation bigint;
  actor_job_id uuid;
  queued_job_id uuid;
  cursor_advances boolean;
  actor_cursor_advances boolean;
  app_enabled boolean;
  project_enabled boolean;
begin
  if p_surface not in ('chat', 'word', 'tabular')
    or p_turn_id is null or p_activity_id is null
    or p_quiet_seconds < 1 or p_quiet_seconds > 3600
  then
    raise exception using errcode = '22023', message = 'invalid_memory_turn';
  end if;
  next_quiet_until := terminal_at + make_interval(secs => p_quiet_seconds);

  -- Lock the canonical source before activity/state/files. The terminal row is
  -- also verified here so a forged or failed assistant id is never scheduled.
  select locked.locked_project_id into canonical_project_id
  from public.lock_memory_conversation_source(
    p_surface, p_conversation_id, p_actor_user_id
  ) locked;
  if not found then return; end if;
  if p_surface = 'chat' then
    select message.created_at into terminal_message_at
    from public.chat_messages message
    where message.id = p_turn_id and message.chat_id = p_conversation_id
      and message.role = 'assistant' and message.content is not null
      and message.memory_input_message_id is not null
      and (
        message.author_user_id is null
        or message.author_user_id = p_actor_user_id
        or message.content @> jsonb_build_array(jsonb_build_object(
          'type', 'ask_inputs_response', 'author_user_id', p_actor_user_id
        ))
      )
    for key share;
  elsif p_surface = 'word' then
    select message.created_at into terminal_message_at
    from public.word_chat_messages message
    where message.id = p_turn_id and message.chat_id = p_conversation_id
      and message.role = 'assistant' and message.content is not null
      and message.memory_input_message_id is not null
      and (
        message.author_user_id is null
        or message.author_user_id = p_actor_user_id
        or message.content @> jsonb_build_array(jsonb_build_object(
          'type', 'ask_inputs_response', 'author_user_id', p_actor_user_id
        ))
      )
    for key share;
  else
    select message.created_at into terminal_message_at
    from public.tabular_review_chat_messages message
    where message.id = p_turn_id and message.chat_id = p_conversation_id
      and message.role = 'assistant' and message.content is not null
      and message.memory_input_message_id is not null
      and (
        message.author_user_id is null
        or message.author_user_id = p_actor_user_id
        or message.content @> jsonb_build_array(jsonb_build_object(
          'type', 'ask_inputs_response', 'author_user_id', p_actor_user_id
        ))
      )
    for key share;
  end if;
  if terminal_message_at is null then return; end if;
  if p_project_id is not null and p_project_id is distinct from canonical_project_id then
    raise exception using errcode = '22023', message = 'invalid_memory_project';
  end if;

  insert into public.memory_conversation_activity(
    surface, conversation_id, actor_user_id, quiet_until
  ) values (
    p_surface, p_conversation_id, p_actor_user_id, next_quiet_until
  ) on conflict (surface, conversation_id) do nothing;
  select * into activity from public.memory_conversation_activity current_activity
  where current_activity.surface = p_surface
    and current_activity.conversation_id = p_conversation_id
  for update;
  if not found or activity.deleted_at is not null then return; end if;

  delete from public.memory_conversation_turn_leases lease
  where lease.surface = p_surface
    and lease.conversation_id = p_conversation_id
    and lease.activity_id = p_activity_id
    and lease.actor_user_id is not distinct from p_actor_user_id;
  if not found then return; end if;
  if p_surface = 'chat' then
    update public.chat_messages message
    set memory_eligible_at = terminal_at
    where message.id = p_turn_id and message.chat_id = p_conversation_id;
  elsif p_surface = 'word' then
    update public.word_chat_messages message
    set memory_eligible_at = terminal_at
    where message.id = p_turn_id and message.chat_id = p_conversation_id;
  else
    update public.tabular_review_chat_messages message
    set memory_eligible_at = terminal_at
    where message.id = p_turn_id and message.chat_id = p_conversation_id;
  end if;
  delete from public.memory_conversation_turn_leases lease
  where lease.surface = p_surface
    and lease.conversation_id = p_conversation_id
    and lease.expires_at <= terminal_at;

  cursor_advances := activity.latest_turn_message_at is null
    or (terminal_message_at, p_turn_id) >
       (activity.latest_turn_message_at, activity.latest_turn_id);
  next_conversation_generation := activity.generation + 1;
  update public.memory_conversation_activity current_activity
  set generation = next_conversation_generation,
      latest_turn_id = case when cursor_advances
        then p_turn_id else current_activity.latest_turn_id end,
      latest_turn_message_at = case when cursor_advances
        then terminal_message_at else current_activity.latest_turn_message_at end,
      latest_turn_completed_at = terminal_at,
      latest_turn_actor_user_id = case when cursor_advances
        then p_actor_user_id else current_activity.latest_turn_actor_user_id end,
      project_id = case
        when current_activity.project_id is distinct from canonical_project_id
          then canonical_project_id
        else current_activity.project_id
      end,
      project_curator_actor_user_id = case
        when canonical_project_id is null then null
        when p_project_id is not null then p_actor_user_id
        when current_activity.project_id is distinct from canonical_project_id then null
        else current_activity.project_curator_actor_user_id
      end,
      quiet_until = next_quiet_until,
      actor_user_id = p_actor_user_id,
      updated_at = terminal_at
  where current_activity.surface = p_surface
    and current_activity.conversation_id = p_conversation_id
  returning current_activity.* into activity;

  insert into public.memory_consolidation_states(
    surface, conversation_id, actor_user_id, project_id, source_epoch
  ) values (
    p_surface, p_conversation_id, p_actor_user_id, p_project_id,
    activity.source_epoch
  ) on conflict (surface, conversation_id, actor_user_id) do nothing;
  select * into state from public.memory_consolidation_states current_state
  where current_state.surface = p_surface
    and current_state.conversation_id = p_conversation_id
    and current_state.actor_user_id = p_actor_user_id
  for update;

  actor_cursor_advances := state.latest_terminal_message_at is null
    or (terminal_message_at, p_turn_id) >
       (state.latest_terminal_message_at, state.latest_turn_id);
  actor_generation := state.generation + 1;
  update public.memory_consolidation_states current_state
  set generation = actor_generation,
      conversation_generation = next_conversation_generation,
      source_epoch = activity.source_epoch,
      latest_turn_id = case when actor_cursor_advances
        then p_turn_id else current_state.latest_turn_id end,
      latest_terminal_message_at = case when actor_cursor_advances
        then terminal_message_at else current_state.latest_terminal_message_at end,
      latest_terminal_at = terminal_at,
      project_id = case when p_project_id is not null
        then p_project_id else current_state.project_id end,
      run_after = next_quiet_until,
      status = 'idle',
      last_error_code = null,
      updated_at = terminal_at
  where current_state.id = state.id;

  -- Extend the global quiet generation without losing any actor's most recent
  -- successful cursor. The retained project curator is also rearmed even when
  -- their app cursor was already processed, so a viewer's later project turn
  -- can still be learned by a currently-authorized editor.
  update public.memory_consolidation_states rearmed
  set generation = rearmed.generation + 1,
      conversation_generation = next_conversation_generation,
      source_epoch = activity.source_epoch,
      run_after = next_quiet_until,
      status = 'idle',
      last_error_code = null,
      updated_at = terminal_at
  where rearmed.surface = p_surface
    and rearmed.conversation_id = p_conversation_id
    and rearmed.id <> state.id
    and rearmed.latest_turn_id is not null
    and (
      rearmed.processed_generation < rearmed.generation
      or rearmed.actor_user_id = activity.project_curator_actor_user_id
    );

  insert into public.memory_files(scope, user_id, enabled)
  select distinct 'user', pending.actor_user_id, true
  from public.memory_consolidation_states pending
  where pending.surface = p_surface
    and pending.conversation_id = p_conversation_id
    and pending.latest_turn_id is not null
    and pending.processed_generation < pending.generation
  on conflict do nothing;
  if activity.project_id is not null then
    insert into public.memory_files(scope, project_id, enabled)
    values ('project', activity.project_id, false)
    on conflict do nothing;
  end if;

  perform memory_file.id
  from public.memory_files memory_file
  where (memory_file.scope = 'user' and memory_file.user_id in (
      select pending.actor_user_id
      from public.memory_consolidation_states pending
      where pending.surface = p_surface
        and pending.conversation_id = p_conversation_id
        and pending.latest_turn_id is not null
        and pending.processed_generation < pending.generation
    )) or (
      memory_file.scope = 'project'
      and memory_file.project_id = activity.project_id
    )
  order by memory_file.id
  for update;

  for queued_state in
    select pending.* from public.memory_consolidation_states pending
    where pending.surface = p_surface
      and pending.conversation_id = p_conversation_id
      and pending.latest_turn_id is not null
      and pending.processed_generation < pending.generation
    order by pending.actor_user_id, pending.id
    for update
  loop
    select * into app_file from public.memory_files memory_file
    where memory_file.scope = 'user'
      and memory_file.user_id = queued_state.actor_user_id;
    app_enabled := coalesce(app_file.enabled, false);
    project_enabled := false;
    if activity.project_id is not null
      and queued_state.actor_user_id = activity.project_curator_actor_user_id
      and queued_state.project_id = activity.project_id
    then
      select * into project_file from public.memory_files memory_file
      where memory_file.scope = 'project'
        and memory_file.project_id = activity.project_id;
      project_enabled := coalesce(project_file.enabled, false);
    end if;

    if not app_enabled and not project_enabled then
      update public.memory_consolidation_states finished_state
      set processed_generation = queued_state.generation,
          status = 'idle', updated_at = terminal_at
      where finished_state.id = queued_state.id;
      continue;
    end if;

    queued_job_id := gen_random_uuid();
    insert into public.db_jobs(
      id, kind, payload, max_attempts, run_at, dedupe_key
    ) values (
      queued_job_id,
      'memory.consolidate',
      jsonb_build_object(
        'stateId', queued_state.id,
        'generation', queued_state.generation,
        'surface', queued_state.surface,
        'conversationId', queued_state.conversation_id,
        'actorUserId', queued_state.actor_user_id,
        'projectId', queued_state.project_id,
        'turnId', queued_state.latest_turn_id,
        'terminalAt', queued_state.latest_terminal_at,
        'projectTurnId', activity.latest_turn_id,
        'projectTerminalAt', activity.latest_turn_completed_at,
        'conversationGeneration', next_conversation_generation,
        'sourceEpoch', queued_state.source_epoch,
        'appEpoch', case when app_enabled then app_file.epoch else null end,
        'projectEpoch', case when project_enabled then project_file.epoch else null end
      ),
      5,
      next_quiet_until,
      'memory:' || queued_state.id::text || ':' ||
        queued_state.generation::text || ':' || next_conversation_generation::text
    );
    update public.memory_consolidation_states scheduled_state
    set status = 'scheduled', updated_at = terminal_at
    where scheduled_state.id = queued_state.id;
    if app_enabled then
      update public.memory_files memory_file
      set status = case when memory_file.status = 'processing'
        then memory_file.status else 'scheduled' end
      where memory_file.id = app_file.id;
    end if;
    if project_enabled then
      update public.memory_files memory_file
      set status = case when memory_file.status = 'processing'
        then memory_file.status else 'scheduled' end
      where memory_file.id = project_file.id;
    end if;
    if queued_state.id = state.id then actor_job_id := queued_job_id; end if;
  end loop;

  if actor_job_id is not null then
    return query select actor_job_id, actor_generation;
  end if;
end;
$$;

create or replace function public.set_memory_consolidation_status(
  p_state_id uuid,
  p_generation bigint,
  p_status text,
  p_error_code text default null,
  p_mark_processed boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.memory_consolidation_states%rowtype;
begin
  if p_status not in ('idle', 'processing', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_memory_status';
  end if;
  select * into state from public.memory_consolidation_states
  where id = p_state_id for update;
  if not found or state.generation <> p_generation then
    return false;
  end if;
  update public.memory_consolidation_states
  set status = p_status,
      processed_generation = case
        when p_mark_processed then greatest(processed_generation, p_generation)
        else processed_generation
      end,
      last_error_code = p_error_code,
      updated_at = now()
  where id = state.id;
  return true;
end;
$$;

create or replace function public.refresh_memory_file_status(
  p_memory_file_id uuid,
  p_expected_epoch bigint,
  p_current_job_id uuid,
  p_requested_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.memory_files%rowtype;
  next_status text := p_requested_status;
begin
  if p_requested_status not in ('idle', 'scheduled', 'processing', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_memory_status';
  end if;
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found or not target.enabled or target.epoch <> p_expected_epoch then
    return false;
  end if;
  if p_requested_status <> 'processing' then
    if exists (
      select 1 from public.db_jobs job
      where job.kind = 'memory.consolidate'
        and job.id <> p_current_job_id
        and job.status = 'running'
        and (
          (target.scope = 'user'
            and job.payload->>'actorUserId' = target.user_id::text
            and job.payload->>'appEpoch' = target.epoch::text)
          or
          (target.scope = 'project'
            and job.payload->>'projectId' = target.project_id::text
            and job.payload->>'projectEpoch' = target.epoch::text)
        )
    ) then
      next_status := 'processing';
    elsif exists (
      select 1 from public.db_jobs job
      where job.kind = 'memory.consolidate'
        and job.id <> p_current_job_id
        and job.status = 'pending'
        and (
          (target.scope = 'user'
            and job.payload->>'actorUserId' = target.user_id::text
            and job.payload->>'appEpoch' = target.epoch::text)
          or
          (target.scope = 'project'
            and job.payload->>'projectId' = target.project_id::text
            and job.payload->>'projectEpoch' = target.epoch::text)
        )
    ) then
      next_status := 'scheduled';
    end if;
  end if;
  update public.memory_files
  set status = next_status,
      last_error_code = case
        when next_status = 'failed' then p_error_code
        else null
      end,
      updated_at = now()
  where id = target.id;
  return true;
end;
$$;

revoke all on public.memory_files from anon, authenticated;
revoke all on public.memory_file_versions from anon, authenticated;
revoke all on public.memory_object_candidates from anon, authenticated;
revoke all on public.memory_consolidation_states from anon, authenticated;
revoke all on public.memory_conversation_activity from anon, authenticated;
revoke all on public.memory_conversation_turn_leases from anon, authenticated;
revoke all on public.memory_consolidation_results from anon, authenticated;
revoke all on function public.begin_memory_file_upload(uuid, bigint, bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_project_with_memory(uuid, text, text, text, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.initialize_new_user_memory()
  from public, anon, authenticated;
revoke all on function public.lock_memory_conversation_source(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fence_memory_conversation_delete()
  from public, anon, authenticated;
revoke all on function public.fence_memory_file_delete()
  from public, anon, authenticated;
revoke all on function public.claim_memory_upload_candidate(uuid)
  from public, anon, authenticated;
revoke all on function public.advance_memory_file(uuid, bigint, bigint, uuid, uuid, text, integer, text, text, text, uuid, text, text, uuid, uuid, uuid, uuid, bigint, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.wipe_memory_file(uuid, boolean, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.enable_memory_file(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.begin_memory_conversation_turn(text, uuid, uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.release_memory_conversation_turn(text, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.schedule_memory_consolidation(text, uuid, uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.set_memory_consolidation_status(uuid, bigint, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.refresh_memory_file_status(uuid, bigint, uuid, text, text)
  from public, anon, authenticated;

grant select, insert, update, delete on public.memory_files to service_role;
grant select, insert, update, delete on public.memory_file_versions to service_role;
grant select, insert, update, delete on public.memory_object_candidates to service_role;
grant select, insert, update, delete on public.memory_consolidation_states to service_role;
grant select, insert, update, delete on public.memory_conversation_activity to service_role;
grant select, insert, update, delete on public.memory_conversation_turn_leases to service_role;
grant select, insert, update, delete on public.memory_consolidation_results to service_role;
grant execute on function public.begin_memory_file_upload(uuid, bigint, bigint, uuid, text)
  to service_role;
grant execute on function public.create_project_with_memory(uuid, text, text, text, uuid, boolean)
  to service_role;
grant execute on function public.initialize_new_user_memory()
  to service_role;
grant execute on function public.lock_memory_conversation_source(text, uuid, uuid)
  to service_role;
grant execute on function public.fence_memory_conversation_delete()
  to service_role;
grant execute on function public.fence_memory_file_delete()
  to service_role;
grant execute on function public.claim_memory_upload_candidate(uuid)
  to service_role;
grant execute on function public.advance_memory_file(uuid, bigint, bigint, uuid, uuid, text, integer, text, text, text, uuid, text, text, uuid, uuid, uuid, uuid, bigint, bigint, bigint)
  to service_role;
grant execute on function public.wipe_memory_file(uuid, boolean, uuid, text, boolean)
  to service_role;
grant execute on function public.enable_memory_file(uuid, uuid)
  to service_role;
grant execute on function public.begin_memory_conversation_turn(text, uuid, uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.release_memory_conversation_turn(text, uuid, uuid, integer)
  to service_role;
grant execute on function public.schedule_memory_consolidation(text, uuid, uuid, uuid, uuid, uuid, integer)
  to service_role;
grant execute on function public.set_memory_consolidation_status(uuid, bigint, text, text, boolean)
  to service_role;
grant execute on function public.refresh_memory_file_status(uuid, bigint, uuid, text, text)
  to service_role;

notify pgrst, 'reload schema';
