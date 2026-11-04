-- L11b: a poll tick claims the earliest claimable jobs by walking each
-- claim path's partial index in run_at order, not by reading and sorting
-- every due row in the queue.
begin;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
$$;
create temporary table job_labels(id uuid,label text);
do $$
declare before bigint; reads bigint; claimed text[];
begin
  -- A backlog of due work, plus one row on each other claim path, each
  -- earlier than the whole backlog, and rows no path may claim.
  insert into public.db_jobs(kind,run_at) select 'test.backlog',now()-interval '1 hour'+n*interval '1 ms' from generate_series(1,5000) n;
  with inserted as (
    insert into public.db_jobs(kind,status,run_at,claimed_at,attempts,max_attempts) values
      ('test.first','pending',now()-interval '5 hours',null,0,5),
      ('storage.cleanup','failed',now()-interval '4 hours',null,9,9),
      ('test.stale','running',now()-interval '3 hours',now()-interval '1 day',1,5),
      ('test.spent','running',now()-interval '6 hours',now()-interval '1 day',5,5),
      ('test.future','pending',now()+interval '1 hour',null,0,5),
      ('test.failed','failed',now()-interval '7 hours',null,5,5),
      ('test.kind','pending',now()-interval '2 minutes',null,0,5)
    returning id,kind)
  insert into job_labels select id,kind from inserted;
  analyze public.db_jobs;
  before:=pg_temp.rel_work('public.db_jobs');
  select array_agg(coalesce(l.label,'backlog') order by coalesce(l.label,'backlog')) into claimed
    from public.claim_db_jobs(5,600,null) j left join job_labels l on l.id=j.id;
  reads:=pg_temp.rel_work('public.db_jobs')-before;
  assert claimed=array['backlog','backlog','storage.cleanup','test.first','test.stale'],format('claimed %s',claimed);
  assert (select status='failed' from public.db_jobs where kind='test.spent'),'spent stale job is still abandoned';
  assert reads<200,format('one claim of 5 jobs read %s job rows',reads);
  -- The kind-scoped claim reads that kind's rows, in order.
  select array_agg(coalesce(l.label,'backlog') order by j.run_at) into claimed
    from public.claim_db_jobs(5,600,'test.kind') j left join job_labels l on l.id=j.id;
  assert claimed=array['test.kind'],format('kind claim %s',claimed);
  assert (select count(*)=4998 from public.db_jobs where kind='test.backlog' and status='pending'),'unclaimed rows stay pending';
end;
$$;
rollback;
