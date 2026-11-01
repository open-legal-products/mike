-- Migration date: 2026-10-30
-- migrate:no-transaction
-- Cleanup must locate surviving references by key, not scan every live version.
-- Built without the SHARE lock a plain build holds, so uploads keep working.
create index concurrently if not exists document_versions_storage_path_idx
  on public.document_versions(storage_path) where deleted_at is null and storage_path is not null;
create index concurrently if not exists document_versions_pdf_storage_path_idx
  on public.document_versions(pdf_storage_path) where deleted_at is null and pdf_storage_path is not null;
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('document_versions_storage_path_idx','document_versions_pdf_storage_path_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
