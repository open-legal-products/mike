-- Migration date: 2026-11-01
-- migrate:no-transaction
-- Every ON DELETE CASCADE / SET NULL runs "where <child column> = <deleted
-- parent id>" once per deleted parent row. Without an index led by that
-- column each one scans the whole child table across every tenant. Nullable
-- columns are indexed only where set: the cascade's equality implies it.
create index concurrently if not exists tabular_cells_row_idx
  on public.tabular_cells(row_id);
create index concurrently if not exists tabular_cells_document_idx
  on public.tabular_cells(document_id);
create index concurrently if not exists tabular_review_rows_document_idx
  on public.tabular_review_rows(document_id) where document_id is not null;
create index concurrently if not exists tabular_review_rows_folder_idx
  on public.tabular_review_rows(folder_id) where folder_id is not null;
create index concurrently if not exists tabular_review_rows_library_folder_idx
  on public.tabular_review_rows(library_folder_id) where library_folder_id is not null;
create index concurrently if not exists documents_current_version_idx
  on public.documents(current_version_id) where current_version_id is not null;
create index concurrently if not exists documents_folder_idx
  on public.documents(folder_id) where folder_id is not null;
create index concurrently if not exists documents_library_folder_idx
  on public.documents(library_folder_id) where library_folder_id is not null;
create index concurrently if not exists playbook_runs_edited_version_idx
  on public.playbook_runs(edited_version_id) where edited_version_id is not null;
create index concurrently if not exists tabular_reviews_workflow_idx
  on public.tabular_reviews(workflow_id) where workflow_id is not null;
create index concurrently if not exists project_subfolders_parent_idx
  on public.project_subfolders(parent_folder_id) where parent_folder_id is not null;
-- clear_org_private_item_access deletes "where kind=<item kind> and
-- item_id=<deleted item>" on every delete/move/archive of a project,
-- workflow, chat, review or document. Neither existing index leads with it.
create index concurrently if not exists org_private_content_access_item_idx
  on public.org_private_content_access(kind,item_id);
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('tabular_cells_row_idx','tabular_cells_document_idx','tabular_review_rows_document_idx','tabular_review_rows_folder_idx','tabular_review_rows_library_folder_idx','documents_current_version_idx','documents_folder_idx','documents_library_folder_idx','playbook_runs_edited_version_idx','tabular_reviews_workflow_idx','project_subfolders_parent_idx','org_private_content_access_item_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
