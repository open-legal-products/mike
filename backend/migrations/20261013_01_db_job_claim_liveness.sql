-- Migration date: 2026-10-13
-- Additive: old running claims retain their claimed_at lifetime through COALESCE.
alter table public.db_jobs add column if not exists heartbeat_at timestamptz;
create index if not exists db_jobs_running_heartbeat_idx
  on public.db_jobs (coalesce(heartbeat_at, claimed_at))
  where status = 'running';

create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600,
  p_kind text default null
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
       and coalesce(heartbeat_at, claimed_at) < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind not in ('storage.cleanup', 'document.cleanup')
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (p_kind is null or kind = p_kind)
       and ((status = 'pending' and run_at <= now())
        -- Cleanup intents are retried forever, but politely: a revived
        -- `failed` row waits for its own run_at like everything else.
        or (status = 'failed'
            and kind in ('storage.cleanup', 'document.cleanup')
            and run_at <= now())
        or (status = 'running'
            and coalesce(heartbeat_at, claimed_at) < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind in ('storage.cleanup', 'document.cleanup')
            )))
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         heartbeat_at = now(),
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
         -- Back the revived row off before running it, so a claimant that
         -- fails the row back to `failed` (an old runner rejecting an unknown
         -- kind) cannot re-enter this branch on the next tick.
         run_at = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then now() + least(
               interval '10 minutes',
               make_interval(secs => 30 * least(j.attempts::bigint + 1, 20))
             )
           else j.run_at
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
revoke all on function public.claim_db_jobs(integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_db_jobs(integer, integer, text)
  to service_role;

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
         heartbeat_at = now(),
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
         run_at = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then now() + least(
               interval '10 minutes',
               make_interval(secs => 30 * least(j.attempts::bigint + 1, 20))
             )
           else j.run_at
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
           and j.kind in ('storage.cleanup', 'document.cleanup')
           and j.run_at <= now())
       or (j.status = 'running'
           and coalesce(j.heartbeat_at, j.claimed_at) < now() - make_interval(secs => p_stale_seconds)
           and (
             j.attempts < j.max_attempts
             or j.kind in ('storage.cleanup', 'document.cleanup')
           )))
  returning j.*;
$$;
revoke all on function public.claim_db_job(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_db_job(uuid, integer)
  to service_role;


-- Evaluate wall time only AFTER acquiring the claim lock: transaction-start
-- now() could admit a claim which expired while waiting behind another writer.
create or replace function public.heartbeat_db_job(
  p_id uuid, p_attempts integer, p_claimed_at timestamptz
)
returns table (id uuid, heartbeat_at timestamptz)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_job public.db_jobs%rowtype;
  v_now timestamptz;
begin
  select j.* into v_job from public.db_jobs j
   where j.id = p_id and j.status = 'running'
     and j.attempts = p_attempts and j.claimed_at = p_claimed_at
   for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if coalesce(v_job.heartbeat_at, v_job.claimed_at) is null
     or coalesce(v_job.heartbeat_at, v_job.claimed_at) < v_now - interval '600 seconds'
  then return; end if;
  return query update public.db_jobs j set heartbeat_at = v_now
    where j.id = p_id returning j.id, j.heartbeat_at;
end;
$$;
revoke all on function public.heartbeat_db_job(uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.heartbeat_db_job(uuid, integer, timestamptz)
  to service_role;

create or replace function public.settle_live_db_job(
  p_id uuid, p_attempts integer, p_claimed_at timestamptz,
  p_outcome text, p_result jsonb, p_last_error text, p_run_at timestamptz,
  p_refund_attempt boolean default false
)
returns table (id uuid)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_job public.db_jobs%rowtype;
  v_now timestamptz;
begin
  if p_outcome is null or p_outcome not in ('done', 'pending', 'failed') then
    raise exception 'invalid settlement outcome' using errcode = '22023';
  end if;
  if p_outcome = 'pending' and (p_run_at is null or not isfinite(p_run_at)) then
    raise exception 'pending settlement requires finite run_at' using errcode = '22023';
  end if;
  if p_refund_attempt is null or (p_refund_attempt and p_outcome <> 'pending') then
    raise exception 'refund requires pending settlement' using errcode = '22023';
  end if;
  select j.* into v_job from public.db_jobs j
   where j.id = p_id and j.status = 'running'
     and j.attempts = p_attempts and j.claimed_at = p_claimed_at
   for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if coalesce(v_job.heartbeat_at, v_job.claimed_at) is null
     or coalesce(v_job.heartbeat_at, v_job.claimed_at) < v_now - interval '600 seconds'
  then return; end if;
  return query update public.db_jobs j
     set status = p_outcome, result = p_result, last_error = p_last_error,
         run_at = case when p_outcome = 'pending' then p_run_at else j.run_at end,
         finished_at = case when p_outcome = 'pending' then null else v_now end,
         attempts = case when p_refund_attempt then greatest(j.attempts - 1, 0) else j.attempts end
   where j.id = p_id returning j.id;
end;
$$;
revoke all on function public.settle_live_db_job(uuid, integer, timestamptz, text, jsonb, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.settle_live_db_job(uuid, integer, timestamptz, text, jsonb, text, timestamptz, boolean)
  to service_role;

notify pgrst, 'reload schema';
