-- M-S8: every db_jobs payload lookup the backend issues is an index
-- condition on that payload key, not a filter over the whole queue history.
-- Statements are prepared the way PostgREST sends them (parameterized) and
-- checked under a generic plan.
begin;
insert into public.db_jobs(kind,status,payload)
  select (array['export.build','memory.consolidate','document.extract_text','document.precompute_text','other'])[1+n%5],
    (array['pending','running','done','failed'])[1+n%4],
    jsonb_build_object('userId',gen_random_uuid(),'actorUserId',gen_random_uuid(),'versionId',gen_random_uuid(),
      'base',jsonb_build_object('userId',gen_random_uuid()))
  from generate_series(1,5000) n;
analyze public.db_jobs;
set local enable_seqscan=off;
set local plan_cache_mode=force_generic_plan;
do $$
declare probe record; plan jsonb;
begin
  for probe in select * from (values
    ('user.accountJobs export artifacts','userId',$q$select id,result from public.db_jobs where kind='export.build' and (payload->>'userId')=$1::text$q$),
    ('user.accountJobs actor memory jobs','actorUserId',$q$select payload from public.db_jobs where kind='memory.consolidate' and (payload->>'actorUserId')=$1::text$q$),
    ('user.accountJobs purge by userId','userId',$q$delete from public.db_jobs where (payload->>'userId')=$1::text and id<>gen_random_uuid()$q$),
    ('user.accountJobs purge by base.userId','userId',$q$delete from public.db_jobs where (payload->'base'->>'userId')=$1::text and id<>gen_random_uuid()$q$),
    ('user.accountJobs purge actor memory','actorUserId',$q$delete from public.db_jobs where kind='memory.consolidate' and (payload->>'actorUserId')=$1::text and id<>gen_random_uuid()$q$),
    ('documents.indexing inline text jobs','versionId',$q$select * from public.db_jobs where kind='document.extract_text' and status='pending' and (payload->>'versionId')=any(array[$1::text]) order by created_at limit 5$q$),
    ('document_cache_writer_active','versionId',$q$select exists(select 1 from public.db_jobs j where j.kind='document.precompute_text' and j.status='running' and (j.payload->>'versionId')=any(array[$1::text]))$q$)
  ) x(caller,payload_key,statement) loop
    execute 'prepare payload_probe(text) as '||probe.statement;
    execute 'explain (format json) execute payload_probe(''x'')' into plan;
    deallocate payload_probe;
    if not exists(select 1 from jsonb_path_query(plan,'$.**."Index Cond"') c where c #>> '{}' like '%'||probe.payload_key||'%') then
      raise exception '% reads db_jobs without a % index: %',probe.caller,probe.payload_key,plan;
    end if;
  end loop;
end;
$$;
rollback;
