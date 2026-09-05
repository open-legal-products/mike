-- Migration date: 2026-06-02

-- Temporary live-Supabase migration: add document_versions.filename without
-- renaming or dropping document_versions.display_name yet.

ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS filename text;

DO $$
BEGIN
  -- display_name is renamed/dropped by later migrations. Only backfill while
  -- the transitional source column is still present.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'document_versions'
      AND column_name = 'display_name'
  ) THEN
    UPDATE public.document_versions
    SET filename = display_name
    WHERE (filename IS NULL OR btrim(filename) = '')
      AND display_name IS NOT NULL
      AND btrim(display_name) <> '';
  END IF;
END $$;
