-- Migration date: 2026-11-01
-- claim_db_jobs ORed its three claim paths (due pending, revivable failed
-- cleanup, stale running) and then ordered by run_at with LIMIT, which no
-- index can serve: every poll tick read and sorted every due row, and the
-- final update hash-joined the whole table. Each path now reads its own
-- partial index in run_at order and stops at p_limit; the update probes the
-- claimed ids by primary key. Same rows claimed, same updates applied.
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
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind not in ('storage.cleanup', 'document.cleanup')
    returning id
  ), candidates as (
    -- One arm per way a row can be claimable, each read in run_at order
    -- from its own partial index and stopped after p_limit unlocked rows,
    -- then merged. A single OR of the three conditions could use no index
    -- order, so every tick read and sorted every due row. Arms are disjoint
    -- (by status, and by whether p_kind is given; that test is a one-time
    -- filter). Each arm may lock up to p_limit rows it then does not claim;
    -- those stay locked only until this statement's transaction ends.
    select arms.id from (
      select * from (select id,run_at from public.db_jobs
        where p_kind is null and status = 'pending' and run_at <= now()
        order by run_at limit p_limit for update skip locked) pending_any
      union all
      select * from (select id,run_at from public.db_jobs
        where kind = p_kind and status = 'pending' and run_at <= now()
        order by run_at limit p_limit for update skip locked) pending_kind
      -- Cleanup intents are retried forever, but politely: a revived
      -- `failed` row waits for its own run_at like everything else.
      union all
      select * from (select id,run_at from public.db_jobs
        where status = 'failed'
          and kind in ('storage.cleanup', 'document.cleanup')
          and run_at <= now()
          and (p_kind is null or kind = p_kind)
        order by run_at limit p_limit for update skip locked) failed_cleanup
      union all
      select * from (select id,run_at from public.db_jobs
        where status = 'running'
          and claimed_at < now() - make_interval(secs => p_stale_seconds)
          and (
            attempts < max_attempts
            or kind in ('storage.cleanup', 'document.cleanup')
          )
          and (p_kind is null or kind = p_kind)
        order by run_at limit p_limit for update skip locked) stale_running
    ) arms
    order by arms.run_at
    limit p_limit
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
   -- Primary-key probes for the few claimed ids. A join to the CTE is
   -- planned without knowing p_limit and hash-joined the whole table.
   where j.id = any (array(select id from candidates))
  returning j.*;
$$;
