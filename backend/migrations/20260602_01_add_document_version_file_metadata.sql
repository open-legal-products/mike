-- Migration date: 2026-06-02

-- Add per-version file metadata.
--
-- documents is the stable container. document_versions owns the bytes for each
-- version, so file metadata that describes those bytes belongs here too.
--
-- Safe to run before application code changes: this only adds nullable columns
-- and backfills them from the parent document.

ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS file_type text,
  ADD COLUMN IF NOT EXISTS size_bytes integer,
  ADD COLUMN IF NOT EXISTS page_count integer;

DO $$
BEGIN
  -- These source columns are removed by a later migration. On a re-run
  -- against the current schema, the per-version values are already canonical.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND column_name = 'file_type'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND column_name = 'size_bytes'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND column_name = 'page_count'
  ) THEN
    UPDATE public.document_versions dv
    SET
      file_type = COALESCE(NULLIF(btrim(dv.file_type), ''), d.file_type),
      size_bytes = COALESCE(dv.size_bytes, d.size_bytes),
      page_count = COALESCE(dv.page_count, d.page_count)
    FROM public.documents d
    WHERE dv.document_id = d.id
      AND (
        dv.file_type IS NULL
        OR btrim(dv.file_type) = ''
        OR dv.size_bytes IS NULL
        OR dv.page_count IS NULL
      );
  END IF;
END $$;
