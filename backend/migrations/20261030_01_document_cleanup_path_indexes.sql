-- Migration date: 2026-10-30
-- Cleanup must locate surviving references by key, not scan every live version.
create index if not exists document_versions_storage_path_idx
  on public.document_versions(storage_path) where deleted_at is null and storage_path is not null;
create index if not exists document_versions_pdf_storage_path_idx
  on public.document_versions(pdf_storage_path) where deleted_at is null and pdf_storage_path is not null;
