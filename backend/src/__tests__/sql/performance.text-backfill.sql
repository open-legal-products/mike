-- M-S2: the document-text backfill sweep starts from unfinished text rows.
-- With nothing to do it reads (almost) nothing; with work it picks the same
-- versions in the same priority order as the original full scan.
-- The original work list, verbatim apart from locking and queueing.
create function pg_temp.backfill_oracle(p_limit integer,p_retry_failed boolean) returns setof uuid
language sql stable set search_path=public,pg_temp as $$
  select v.id from public.document_versions v join public.documents d on d.id=v.document_id
    left join public.document_version_texts t on t.version_id=v.id
    where v.deleted_at is null and v.storage_path is not null and d.archived_at is null
      and (t.version_id is null or t.source_revision<>v.text_revision or t.extractor_version<>1
        or t.status in ('pending','processing') or (p_retry_failed and t.status='failed'))
      and not exists(select 1 from public.db_jobs j where j.dedupe_key='document.text:'||v.id||':'||v.text_revision
        and j.status in ('pending','running'))
    order by (v.id=d.current_version_id) desc, v.id
    limit least(greatest(coalesce(p_limit,100),1),500);
$$;
-- The versions one backfill call queues, in order, rolled back afterwards.
create function pg_temp.backfill_queues(p_limit integer,p_retry_failed boolean) returns uuid[]
language plpgsql set search_path=public,pg_temp as $$
declare queued uuid[];
begin
  begin
    perform public.backfill_document_text(p_limit,p_retry_failed);
    select array_agg((payload->>'versionId')::uuid order by (v.id=d.current_version_id) desc, v.id) into queued
      from public.db_jobs j join public.document_versions v on v.id=(j.payload->>'versionId')::uuid
      join public.documents d on d.id=v.document_id
      where j.kind='document.extract_text' and j.status='pending' and j.created_at=now() and j.id not in (select id from pre_jobs);
    raise exception using errcode='P0001',message=coalesce(queued::text,'{}');
  exception when sqlstate 'P0001' then
    return sqlerrm::uuid[];
  end;
end;
$$;

-- With every version's text ready, a sweep reads almost no versions.
begin;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
$$;
do $$
declare actor uuid:=gen_random_uuid(); before bigint; reads bigint; queued integer;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into public.documents(user_id) select actor from generate_series(1,3000);
  insert into public.document_versions(document_id,version_number,storage_path,filename)
    select id,1,'synthetic/'||id,'Synthetic.pdf' from public.documents where user_id=actor;
  update public.documents d set current_version_id=v.id from public.document_versions v where v.document_id=d.id and d.user_id=actor;
  perform public.publish_document_text(v.id,v.text_revision,'text',null,0) from public.document_versions v join public.documents d on d.id=v.document_id where d.user_id=actor;
  delete from public.db_jobs where kind='document.extract_text';
  analyze public.document_versions; analyze public.document_version_texts; analyze public.documents;
  before:=pg_temp.rel_work('public.document_versions')+pg_temp.rel_work('public.document_version_texts');
  queued:=public.backfill_document_text(100,false);
  reads:=pg_temp.rel_work('public.document_versions')+pg_temp.rel_work('public.document_version_texts')-before;
  assert queued=0,'nothing to backfill';
  assert reads<100,format('an idle backfill sweep read %s version and text rows',reads);
end;
$$;
rollback;

-- Same work list and order: every state the triggers produce, then versions
-- from before text search (no row, stale revision, old extractor) after the
-- 20261101_23 normalization that runs on upgrade.
begin;
create temporary table pre_jobs(id uuid);
do $$
declare actor uuid:=gen_random_uuid(); doc uuid; v1 uuid; v2 uuid; i integer;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  for i in 1..12 loop
    insert into public.documents(user_id,archived_at) values(actor,case when i=5 then now() end) returning id into doc;
    insert into public.document_versions(document_id,version_number,storage_path,filename) values(doc,1,'synthetic/'||doc||'/1','A.pdf') returning id into v1;
    insert into public.document_versions(document_id,version_number,storage_path,filename) values(doc,2,case when i=6 then null else 'synthetic/'||doc||'/2' end,'A.pdf') returning id into v2;
    update public.documents set current_version_id=case when i%2=0 then v1 else v2 end where id=doc;
    perform set_config('mike.backfill_v1_'||i,v1::text,true); perform set_config('mike.backfill_v2_'||i,v2::text,true);
  end loop;
  -- Jobs lost for most rows (the sweep's reason to exist); two keep a live job.
  delete from public.db_jobs where kind='document.extract_text'
    and payload->>'versionId' not in (current_setting('mike.backfill_v1_1'),current_setting('mike.backfill_v2_2'));
  perform public.publish_document_text(v.id,v.text_revision,'text',null,0) from public.document_versions v
    where v.id::text in (current_setting('mike.backfill_v1_3'),current_setting('mike.backfill_v2_3'),current_setting('mike.backfill_v1_8'));
  update public.document_version_texts set status='processing' where version_id::text=current_setting('mike.backfill_v2_4');
  update public.document_version_texts set status='failed',error_code='extraction_failed' where version_id::text in (current_setting('mike.backfill_v1_7'),current_setting('mike.backfill_v2_9'));
  update public.document_versions set deleted_at=now() where id::text=current_setting('mike.backfill_v1_10');
  insert into pre_jobs select id from public.db_jobs;
end;
$$;
do $$
declare lim integer; retry boolean;
begin
  foreach lim in array array[1,3,7,100] loop
    foreach retry in array array[false,true] loop
      assert pg_temp.backfill_queues(lim,retry)=array(select pg_temp.backfill_oracle(lim,retry)),
        format('backfill work list changed (limit %s, retry %s)',lim,retry);
    end loop;
  end loop;
end;
$$;
-- Versions as text search found them: no row, a ready row for an older
-- revision, a ready row from an older extractor.
delete from public.document_version_texts where version_id::text in (current_setting('mike.backfill_v1_11'),current_setting('mike.backfill_v2_12'));
update public.document_version_texts set status='ready',text_content='old',source_revision=gen_random_uuid()
  where version_id::text=current_setting('mike.backfill_v2_11');
update public.document_version_texts set status='ready',text_content='old',extractor_version=0
  where version_id::text=current_setting('mike.backfill_v1_12');
create temporary table legacy_expected as
  select lim,retry,array(select pg_temp.backfill_oracle(lim,retry)) ids
  from unnest(array[1,3,7,100]) lim cross join unnest(array[false,true]) retry;
\ir ../../../migrations/20261101_23_document_text_backfill_from_unfinished.sql
do $$
declare expected record;
begin
  for expected in select * from legacy_expected loop
    assert pg_temp.backfill_queues(expected.lim,expected.retry)=expected.ids,
      format('legacy backfill work list changed (limit %s, retry %s)',expected.lim,expected.retry);
  end loop;
end;
$$;
rollback;
