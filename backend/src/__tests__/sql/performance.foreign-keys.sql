-- S1/S8: deleting a parent must find its children by index. A cascade or
-- SET NULL runs a generic "where child_column = $1" per deleted parent row,
-- and clear_org_private_item_access deletes by (kind,item_id) on every item
-- delete, move or archive. Each probe must be an index condition, not a scan
-- of every tenant's rows. PostgreSQL 17 has no B-tree skip scan, so an
-- index whose FIRST key is not the column can only be walked end to end.
begin;
create function pg_temp.leads_with(plan jsonb,column_name text) returns boolean language sql as $$
  select exists(select 1 from jsonb_path_query(plan,'$.** ? (exists (@."Index Name"))') node
    join pg_class i on i.relname=node->>'Index Name' and i.relnamespace='public'::regnamespace
    join pg_index x on x.indexrelid=i.oid
    join pg_attribute a on a.attrelid=x.indrelid and a.attnum=x.indkey[0]
    where a.attname=column_name and node ? 'Index Cond');
$$;
set local enable_seqscan=off;
set local plan_cache_mode=force_generic_plan;
do $$
declare probe record; plan jsonb;
begin
  for probe in select * from (values
    ('tabular_cells','row_id'),('tabular_cells','document_id'),
    ('tabular_review_rows','document_id'),('tabular_review_rows','folder_id'),('tabular_review_rows','library_folder_id'),
    ('documents','current_version_id'),('documents','folder_id'),('documents','library_folder_id'),
    ('playbook_runs','edited_version_id'),('tabular_reviews','workflow_id'),('project_subfolders','parent_folder_id'),
    ('chat_subagent_runs','chat_id')
  ) x(table_name,column_name) loop
    -- The same shape PostgreSQL's referential-integrity triggers prepare.
    execute format('prepare fk_probe(uuid) as select 1 from only public.%I where $1 = %I',probe.table_name,probe.column_name);
    execute 'explain (format json) execute fk_probe(gen_random_uuid())' into plan;
    deallocate fk_probe;
    if not pg_temp.leads_with(plan,probe.column_name) then
      raise exception 'Deleting a parent scans %.% instead of probing an index: %',probe.table_name,probe.column_name,plan;
    end if;
  end loop;
  prepare private_probe(text,uuid) as delete from public.org_private_content_access where kind=$1 and item_id=$2;
  execute 'explain (format json) execute private_probe(''document'',gen_random_uuid())' into plan;
  deallocate private_probe;
  if not (pg_temp.leads_with(plan,'kind') or pg_temp.leads_with(plan,'item_id')) then
    raise exception 'Clearing private access for one deleted item scans every organization: %',plan;
  end if;
end;
$$;
rollback;
