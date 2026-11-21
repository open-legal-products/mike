-- M-S3: resolving an upload's folder path finds each segment's sibling, and
-- each "(n)" rename candidate, by its normalized name, not by reading every
-- folder in the project or library.
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
declare actor uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); before bigint; reads bigint; result jsonb;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into public.projects(id,user_id,name) values(project,actor,'Folders');
  insert into public.project_subfolders(project_id,user_id,name) select project,actor,'Folder '||n from generate_series(1,3000) n;
  insert into public.project_subfolders(project_id,user_id,name) values(project,actor,' Evidence '),(project,actor,'evidence (2)'),(project,actor,'Evidence (4)');
  insert into public.library_folders(user_id,library_kind,name) select actor,'file','Folder '||n from generate_series(1,3000) n;
  insert into public.library_folders(user_id,library_kind,name) values(actor,'file','Evidence'),(actor,'file','EVIDENCE (2)');
  analyze public.project_subfolders; analyze public.library_folders;
  before:=pg_temp.rel_work('public.project_subfolders');
  result:=public.resolve_project_folder_path(project,actor,null,array['evidence'],'error');
  reads:=pg_temp.rel_work('public.project_subfolders')-before;
  -- The lowest free suffix, not one past the highest: (4) exists, (3) is free.
  assert result->>'conflict'='true' and result->>'suggested_name'='evidence (3)',format('project conflict changed: %s',result);
  assert reads<50,format('one project path segment read %s folder rows',reads);
  before:=pg_temp.rel_work('public.project_subfolders');
  result:=public.resolve_project_folder_path(project,actor,null,array['New','Sub','Leaf'],'reuse');
  reads:=pg_temp.rel_work('public.project_subfolders')-before;
  assert jsonb_array_length(result->'folders')=3,'three folders created';
  assert reads<50,format('a three-segment project path read %s folder rows',reads);
  before:=pg_temp.rel_work('public.library_folders');
  result:=public.resolve_library_folder_path(actor,'file',null,array['evidence'],'error');
  reads:=pg_temp.rel_work('public.library_folders')-before;
  assert result->>'suggested_name'='evidence (3)',format('library conflict changed: %s',result);
  assert reads<50,format('one library path segment read %s folder rows',reads);
end;
$$;
rollback;
