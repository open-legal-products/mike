-- H5: the reference predicates must be equality index probes, not filtered scans.
begin;
-- Populate enough nonmatching rows that the planner must distinguish an
-- equality probe from scanning a tiny empty partial index.
insert into public.documents(id) values ('80000000-0000-0000-0000-000000000001');
insert into public.document_versions(document_id,version_number,storage_path,pdf_storage_path)
select '80000000-0000-0000-0000-000000000001',n,'synthetic/source-'||n,'synthetic/pdf-'||n
from generate_series(1,10000) n;
analyze public.document_versions;
set local enable_seqscan=off;
do $$
declare plan jsonb; column_name text;
begin
  foreach column_name in array array['storage_path','pdf_storage_path'] loop
    execute format('explain (format json) select id from public.document_versions where deleted_at is null and %I=any(array[''synthetic/missing-key''])',column_name) into plan;
    if not jsonb_path_exists(plan,'$.**."Index Cond"') then
      raise exception 'Cleanup % predicate is not an index condition: %',column_name,plan;
    end if;
  end loop;
end;
$$;
rollback;
