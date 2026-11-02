-- Migration date: 2026-10-13
--
-- A person's memory, per workspace.
--
-- App memory was one private file per person. It was read and learned only
-- in personal conversations, so in an organization's workspace it did
-- nothing — except on the first message of a new chat, where the personal
-- file leaked into the prompt.
--
-- A person now has one memory for Personal and one for each team
-- organization they belong to. Each is private to them: not shared with the
-- organization, and not readable by its owners. A conversation reads and
-- learns only the memory of the workspace it is in, so nothing learned in
-- one organization can surface in another, or in Personal.
--
--   memory_files.org_id        the organization a 'user' file is for, or
--                              null for Personal
--   memory_source_org_id()     the workspace a conversation's memory
--                              belongs to
--   ensure_user_memory_file()  create-if-missing, returning the row
--
-- A workspace memory exists only while its person is a member: it is tied
-- to the membership row and goes with it, as their private chats there do.
--
-- Safe to re-run: add column / create index if not exists, drop-before-
-- create for constraints and the replaced index, create or replace.

-- This migration rewrites functions that 20260917_02_memory_followup.sql
-- introduced. A database whose ledger records that file without it ever
-- having run (`migrate.sh baseline` named one file too far) would otherwise
-- stop part-way down with an error about a function that does not exist.
-- Stop here instead, before anything is changed, and say what to do.
do $$
begin
  if to_regprocedure('public.memory_project_is_private(uuid)') is null
    or to_regprocedure('public.delete_user_private_memories(uuid)') is null
    or to_regprocedure(
      'public.memory_source_allows_app_memory(text, uuid, uuid, uuid)'
    ) is null
  then
    raise exception using
      errcode = '55000',
      message = 'This database is missing objects from 20260917_02_memory_followup.sql',
      detail = 'The migration ledger records that file as applied, but the functions it creates are not here. It was most likely recorded by `migrate.sh baseline` without having been run.',
      hint = 'Apply that file by hand (every statement in it is safe to re-run), then run `migrate.sh up` again: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f backend/migrations/20260917_02_memory_followup.sql';
  end if;
end $$;

alter table public.memory_files
  add column if not exists org_id uuid;

-- Only a person's own file is for a workspace. A project's memory is the
-- project's, wherever the project is.
alter table public.memory_files
  drop constraint if exists memory_files_scope_owner_check;
alter table public.memory_files
  add constraint memory_files_scope_owner_check check (
    (scope = 'user' and user_id is not null and project_id is null)
    or (scope = 'project' and project_id is not null and user_id is null
        and org_id is null)
  );

-- Tied to the membership, not just to the organization: leaving, being
-- removed, and the organization being deleted all take it away.
alter table public.memory_files
  drop constraint if exists memory_files_workspace_member_fkey;
alter table public.memory_files
  add constraint memory_files_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

-- One file per person per workspace. Two partial indexes rather than one
-- over (user_id, org_id): null is Personal, and nulls are distinct.
drop index if exists public.memory_files_user_unique;
create unique index if not exists memory_files_user_personal_unique
  on public.memory_files(user_id) where org_id is null;
create unique index if not exists memory_files_user_workspace_unique
  on public.memory_files(user_id, org_id) where org_id is not null;
create index if not exists memory_files_org_idx
  on public.memory_files(org_id) where org_id is not null;

-- The workspace a conversation's own-memory belongs to: the team
-- organization of a chat started on its own there, otherwise null —
-- Personal. A chat in a project, a Word chat and a tabular review chat are
-- never a workspace's: what they may learn is decided by
-- memory_source_allows_app_memory.
create or replace function public.memory_source_org_id(
  p_surface text,
  p_conversation_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_surface = 'chat' then (
    select chat.org_id
    from public.chats chat
    where chat.id = p_conversation_id
      and chat.project_id is null
      and public.org_is_team(chat.org_id)
  ) end;
$$;

-- A person's memory file for one workspace, created if it is not there.
-- Returns nothing for an organization they do not belong to.
--
-- A new workspace memory starts as the person left their Personal one:
-- somebody who turned memory off has not asked for it back because they
-- opened a chat in their firm.
create or replace function public.ensure_user_memory_file(
  p_user_id uuid,
  p_org_id uuid
)
returns setof public.memory_files
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is not null and not exists (
    select 1 from public.org_members member
    where member.org_id = p_org_id and member.user_id = p_user_id
  ) then
    return;
  end if;
  if not exists (
    select 1 from public.memory_files file
    where file.scope = 'user'
      and file.user_id = p_user_id
      and file.org_id is not distinct from p_org_id
  ) then
    insert into public.memory_files(scope, user_id, org_id, enabled)
    values (
      'user',
      p_user_id,
      p_org_id,
      coalesce((
        select personal.enabled from public.memory_files personal
        where personal.scope = 'user'
          and personal.user_id = p_user_id
          and personal.org_id is null
      ), true)
    )
    on conflict do nothing;
  end if;
  return query
    select file.* from public.memory_files file
    where file.scope = 'user'
      and file.user_id = p_user_id
      and file.org_id is not distinct from p_org_id;
end;
$$;

create or replace function public.initialize_new_user_memory()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.memory_files(scope, user_id, enabled)
  values ('user', new.id, true)
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.memory_source_allows_app_memory(
  p_surface text,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_project_id uuid
)
returns boolean
language sql
-- Re-read grants after the caller's project-row lock wait. A stable function
-- could retain the statement's older snapshot while a concurrent share wins.
volatile
security definer
set search_path = public, pg_temp
as $$
  -- App memory is private to one user, so it may only learn from a
  -- conversation nobody else can read. That is a property of the
  -- conversation itself (its owner, organization, and direct grants) and,
  -- when it lives in a project, of the project too. The read path in the
  -- routes applies the same three tests before showing app memory.
  --
  -- A chat started on its own in a team organization's workspace is private
  -- to its author too, and learns into that author's memory FOR THAT
  -- WORKSPACE (memory_source_org_id says which). A chat in an organization's
  -- project is the project's, and never learns into anybody's own memory.
  select case
    when p_surface = 'word' then p_project_id is null
    when p_surface = 'chat' then
      exists (
        select 1
        from public.chats chat
        where chat.id = p_conversation_id
          and chat.user_id = p_actor_user_id
          and (
            not public.org_is_team(chat.org_id)
            or (
              chat.project_id is null
              and exists (
                select 1 from public.org_members member
                where member.org_id = chat.org_id
                  and member.user_id = p_actor_user_id
              )
            )
          )
          and not exists (
            select 1
            from public.chat_access_grants grant_row
            where grant_row.chat_id = chat.id
          )
      )
      and (
        p_project_id is null
        or public.memory_project_is_private(p_project_id)
      )
    when p_surface = 'tabular' then
      p_project_id is not null
      and exists (
        select 1
        from public.tabular_review_chats chat
        join public.tabular_reviews review on review.id = chat.review_id
        where chat.id = p_conversation_id
          and review.user_id = p_actor_user_id
          and review.org_id is null
          and not exists (
            select 1
            from public.tabular_review_access_grants grant_row
            where grant_row.tabular_review_id = review.id
          )
      )
      and public.memory_project_is_private(p_project_id)
    else false
  end;
$$;

create or replace function public.write_memory_file(
  p_memory_file_id uuid,
  p_expected_revision bigint,
  p_expected_epoch bigint,
  p_content text,
  p_content_sha256 text,
  p_size_bytes integer,
  p_source text,
  p_updated_by uuid default null,
  p_source_surface text default null,
  p_source_chat_id uuid default null,
  p_source_job_id uuid default null,
  p_consolidation_state_id uuid default null,
  p_consolidation_generation bigint default null,
  p_conversation_generation bigint default null,
  p_source_epoch bigint default null
)
returns table(applied boolean, new_revision bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.memory_files%rowtype;
  consolidation public.memory_consolidation_states%rowtype;
  activity public.memory_conversation_activity%rowtype;
begin
  if p_source not in ('manual', 'curator') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  if p_size_bytes < 0 or p_size_bytes > 16384 then
    raise exception using errcode = '22023', message = 'memory_content_too_large';
  end if;
  -- Match canonical DELETE's source -> scheduler-state lock order. Holding
  -- this key-share lock through the write makes deletion and learning
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
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
    select * into activity from public.memory_conversation_activity
    where surface = p_source_surface and conversation_id = p_source_chat_id
    for update;
    if not found
      or activity.deleted_at is not null
      or activity.source_epoch <> p_source_epoch
      or activity.generation <> p_conversation_generation
    then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
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
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
  end if;

  select * into target from public.memory_files
  where id = p_memory_file_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  -- A curator job that is retried after its transaction already committed
  -- must not apply the same replacement twice.
  if p_source_job_id is not null
    and target.last_source_job_id = p_source_job_id
  then
    return query select false, target.revision;
    return;
  end if;

  if p_source = 'curator' then
    if (target.scope = 'user' and target.user_id <> consolidation.actor_user_id)
      or (target.scope = 'project' and target.project_id is distinct from consolidation.project_id)
    then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
    if target.scope = 'user'
      and not public.memory_source_allows_app_memory(
        p_source_surface, p_source_chat_id, p_updated_by, activity.project_id
      )
    then
      raise exception using errcode = 'P0001', message = 'memory_scope_ineligible';
    end if;
    -- A conversation learns only into the memory of the workspace it is in:
    -- never an organization's chat into Personal, nor the other way round.
    if target.scope = 'user'
      and target.org_id is distinct from
        public.memory_source_org_id(p_source_surface, p_source_chat_id)
    then
      raise exception using errcode = 'P0001', message = 'memory_scope_ineligible';
    end if;
  end if;

  if not target.enabled then
    raise exception using errcode = 'P0001', message = 'memory_disabled';
  end if;
  if target.epoch <> p_expected_epoch then
    raise exception using errcode = 'P0001', message = 'memory_epoch_conflict';
  end if;
  if target.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'memory_revision_conflict';
  end if;

  -- An unchanged body is not a write: it would burn a revision and, for the
  -- curator, look like new learning in the audit trail. The job receipt is
  -- still stamped so a retried job is recognised above and applied once.
  if target.content_sha256 is not distinct from p_content_sha256 then
    if p_source_job_id is not null then
      update public.memory_files
      set last_source_job_id = p_source_job_id
      where id = p_memory_file_id;
      insert into public.memory_consolidation_results(
        job_id, memory_file_id, scope, outcome, revision
      ) values (
        p_source_job_id, target.id, target.scope, 'no_change', target.revision
      ) on conflict (job_id, memory_file_id) do update
        set outcome = excluded.outcome,
            revision = excluded.revision,
            created_at = now();
    end if;
    return query select false, target.revision;
    return;
  end if;

  update public.memory_files
  set content = p_content,
      content_sha256 = p_content_sha256,
      size_bytes = p_size_bytes,
      revision = target.revision + 1,
      status = case
        when p_source = 'manual' and target.status = 'failed' then 'idle'
        else target.status
      end,
      last_error_code = null,
      last_source = p_source,
      last_source_job_id = p_source_job_id,
      updated_by = p_updated_by,
      updated_at = now()
  where id = p_memory_file_id;

  if p_source_job_id is not null then
    insert into public.memory_consolidation_results(
      job_id, memory_file_id, scope, outcome, revision
    ) values (
      p_source_job_id, target.id, target.scope, 'updated', target.revision + 1
    ) on conflict (job_id, memory_file_id) do update
      set outcome = excluded.outcome,
          revision = excluded.revision,
          created_at = now();
  end if;

  return query select true, target.revision + 1;
end;
$$;

create or replace function public.delete_user_private_memories(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  deleted_projects integer := 0;
begin
  -- Lock the caller's own private projects rather than the whole table.
  -- FOR UPDATE on a project row blocks both a move into an organization (an
  -- UPDATE of that row) and a new access grant (the grant's foreign key takes
  -- KEY SHARE on the project, which FOR UPDATE excludes), so eligibility
  -- cannot change between this check and the wipe. A table-level SHARE lock
  -- did the same job by stalling every project write in the system for as
  -- long as this user's files took to wipe.
  perform project.id from public.projects project
  where project.user_id = p_user_id and project.org_id is null
  order by project.id
  for update;

  insert into public.memory_files(scope, user_id, enabled)
  values ('user', p_user_id, true)
  on conflict do nothing;

  for target in
    select eligible.id, eligible.scope
    from (
      -- Every memory that is this person's own: Personal, and the one
      -- they have in each organization they belong to.
      select file.id, file.scope
      from public.memory_files file
      where file.scope = 'user' and file.user_id = p_user_id
      union all
      select file.id, file.scope
      from public.memory_files file
      join public.projects project on project.id = file.project_id
      where file.scope = 'project'
        and project.user_id = p_user_id
        and project.org_id is null
        and not exists (
          select 1 from public.project_access_grants grant_row
          where grant_row.project_id = project.id
        )
    ) eligible
    order by eligible.id
  loop
    perform public.wipe_memory_file(target.id, null, p_user_id, 'wipe');
    if target.scope = 'project' then
      deleted_projects := deleted_projects + 1;
    end if;
  end loop;

  return deleted_projects;
end;
$$;

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
set search_path = public, pg_temp
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
  app_turn_eligible boolean;
  app_enabled boolean;
  project_enabled boolean;
  pending_actor_ids uuid[];
  -- The workspace whose memory this conversation's actors learn into: a
  -- team organization, or null for Personal.
  workspace_org_id uuid;
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
  app_turn_eligible := public.memory_source_allows_app_memory(
    p_surface, p_conversation_id, p_actor_user_id, canonical_project_id
  );

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
    set memory_eligible_at = terminal_at,
        memory_app_eligible_at = case
          when app_turn_eligible then terminal_at else null end
    where message.id = p_turn_id and message.chat_id = p_conversation_id;
  elsif p_surface = 'word' then
    update public.word_chat_messages message
    set memory_eligible_at = terminal_at,
        memory_app_eligible_at = case
          when app_turn_eligible then terminal_at else null end
    where message.id = p_turn_id and message.chat_id = p_conversation_id;
  else
    update public.tabular_review_chat_messages message
    set memory_eligible_at = terminal_at,
        memory_app_eligible_at = case
          when app_turn_eligible then terminal_at else null end
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
  if not found then
    -- The upsert above guarantees the row; a miss means it was deleted under
    -- us. Every later statement keys on state.id, so continuing would be a
    -- silent no-op that looks exactly like "nothing to schedule".
    raise exception using errcode = 'P0001', message = 'memory_state_missing';
  end if;

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

  workspace_org_id := public.memory_source_org_id(p_surface, p_conversation_id);
  perform public.ensure_user_memory_file(pending.actor_user_id, workspace_org_id)
  from (
    select distinct candidate.actor_user_id
    from public.memory_consolidation_states candidate
    where candidate.surface = p_surface
      and candidate.conversation_id = p_conversation_id
      and candidate.latest_turn_id is not null
      and candidate.processed_generation < candidate.generation
  ) pending;
  if activity.project_id is not null then
    insert into public.memory_files(scope, project_id, enabled)
    values ('project', activity.project_id, true)
    on conflict do nothing;
  end if;

  -- Lock every file this turn may touch, in id order, through the unique
  -- indexes. The obvious "user_id in (subquery) or project_id = ..." shape
  -- cannot use either index under a top-level OR and scanned (and row
  -- locked) the whole table on every assistant turn.
  select coalesce(array_agg(distinct pending.actor_user_id), '{}')
  into pending_actor_ids
  from public.memory_consolidation_states pending
  where pending.surface = p_surface
    and pending.conversation_id = p_conversation_id
    and pending.latest_turn_id is not null
    and pending.processed_generation < pending.generation;
  perform memory_file.id
  from public.memory_files memory_file
  where memory_file.id in (
      select locked_user_file.id from public.memory_files locked_user_file
      where locked_user_file.scope = 'user'
        and locked_user_file.user_id = any(pending_actor_ids)
        and locked_user_file.org_id is not distinct from workspace_org_id
      union all
      select locked_project_file.id
      from public.memory_files locked_project_file
      where locked_project_file.scope = 'project'
        and locked_project_file.project_id = activity.project_id
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
      and memory_file.user_id = queued_state.actor_user_id
      and memory_file.org_id is not distinct from workspace_org_id;
    app_enabled := coalesce(app_file.enabled, false)
      and public.memory_source_allows_app_memory(
        p_surface, p_conversation_id, queued_state.actor_user_id,
        activity.project_id
      );
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
        'appOrgId', case when app_enabled then app_file.org_id else null end,
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
set search_path = public, pg_temp
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
            and job.payload->>'appEpoch' = target.epoch::text
            -- A person has one memory per workspace, and their epochs are
            -- counted separately: a job for one is not a job for another.
            and job.payload->>'appOrgId' is not distinct from target.org_id::text)
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
            and job.payload->>'appEpoch' = target.epoch::text
            -- A person has one memory per workspace, and their epochs are
            -- counted separately: a job for one is not a job for another.
            and job.payload->>'appOrgId' is not distinct from target.org_id::text)
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

revoke all on function public.memory_source_org_id(text, uuid)
  from public, anon, authenticated;
revoke all on function public.ensure_user_memory_file(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.memory_source_org_id(text, uuid)
  to service_role;
grant execute on function public.ensure_user_memory_file(uuid, uuid)
  to service_role;
