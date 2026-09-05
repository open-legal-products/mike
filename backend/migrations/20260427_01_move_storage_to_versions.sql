-- Migration date: 2026-04-27

-- Move storage_path and pdf_storage_path from documents to document_versions.
--
-- Rationale: there were two sources of truth for "where the bytes live"
--  - documents.{storage_path, pdf_storage_path}    (set on initial upload)
--  - document_versions.storage_path                (set on each new version)
-- New-version uploads only updated the latter, so /display, downloads,
-- and assistant context all drifted to the original upload's bytes.
--
-- After this migration:
--  - document_versions owns storage_path and pdf_storage_path.
--  - documents.current_version_id is the only "which version is live" pointer.
--  - documents.{storage_path, pdf_storage_path} are dropped.

-- 1. Add pdf_storage_path to document_versions.
alter table public.document_versions
    add column if not exists pdf_storage_path text;

-- 2. Backfill: ensure every document has at least one document_versions row
--    (the original upload). Older docs may predate document_versions entirely.
do $$
begin
  -- The source columns are removed at the end of this migration. On a
  -- re-run against the current schema, there is nothing left to copy.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name = 'storage_path'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name = 'pdf_storage_path'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name = 'filename'
  ) then
    insert into public.document_versions (
        document_id,
        storage_path,
        pdf_storage_path,
        source,
        version_number,
        display_name,
        created_at
    )
    select
        d.id,
        d.storage_path,
        d.pdf_storage_path,
        'upload',
        1,
        d.filename,
        d.created_at
    from public.documents d
    left join public.document_versions dv
        on dv.document_id = d.id and dv.source = 'upload'
    where dv.id is null
      and d.storage_path is not null;
  end if;
end $$;

-- 3. Backfill pdf_storage_path onto the existing 'upload' rows for docs
--    that already had one but predate document_versions.pdf_storage_path.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name = 'pdf_storage_path'
  ) then
    update public.document_versions dv
    set pdf_storage_path = d.pdf_storage_path
    from public.documents d
    where dv.document_id = d.id
      and dv.source = 'upload'
      and dv.pdf_storage_path is null
      and d.pdf_storage_path is not null;
  end if;
end $$;

-- 4. Backfill current_version_id for any document missing one — point it
--    at the most recent version (assistant_edit / user_upload preferred,
--    else the upload row).
update public.documents d
set current_version_id = sub.id
from (
    select distinct on (document_id) id, document_id
    from public.document_versions
    order by document_id,
        case source
            when 'assistant_edit' then 1
            when 'user_upload'    then 2
            when 'user_accept'    then 3
            when 'user_reject'    then 4
            when 'generated'      then 5
            when 'upload'         then 6
            else 7
        end,
        version_number desc nulls last,
        created_at desc
) sub
where d.id = sub.document_id
  and d.current_version_id is null;

-- 5. Drop the columns from documents.
alter table public.documents drop column if exists storage_path;
alter table public.documents drop column if exists pdf_storage_path;
