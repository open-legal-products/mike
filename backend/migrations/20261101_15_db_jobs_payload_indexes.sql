-- Migration date: 2026-11-01
-- migrate:no-transaction
-- Payload lookups the backend runs against db_jobs. Without these each one
-- reads the whole queue table, done and failed history included:
--  * account erasure deletes every job naming the user (payload userId, or
--    base.userId) and lists that user's export.build jobs;
--  * account erasure lists the user's memory.consolidate jobs by actorUserId
--    in any status (the epoch index covers only live ones);
--  * document_cache_writer_active and the inline text runner find a
--    version's precompute/extract jobs by versionId.
-- Partial predicates keep each index to the rows that carry the key; an
-- equality on the expression implies "is not null", so the planner can use
-- them for parameterized queries.
create index concurrently if not exists db_jobs_payload_user_idx
  on public.db_jobs((payload->>'userId')) where (payload->>'userId') is not null;
create index concurrently if not exists db_jobs_payload_base_user_idx
  on public.db_jobs((payload->'base'->>'userId')) where (payload->'base'->>'userId') is not null;
create index concurrently if not exists db_jobs_memory_actor_idx
  on public.db_jobs((payload->>'actorUserId')) where kind = 'memory.consolidate';
create index concurrently if not exists db_jobs_text_version_idx
  on public.db_jobs((payload->>'versionId'))
  where kind in ('document.extract_text', 'document.precompute_text');
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('db_jobs_payload_user_idx','db_jobs_payload_base_user_idx','db_jobs_memory_actor_idx','db_jobs_text_version_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
