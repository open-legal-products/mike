-- Migration date: 2026-04-24

-- Migration: per-version user-editable display name + user_upload source.
-- Lets users rename individual versions (the assistant-edit default is
-- "[Edited V{n}]") and differentiate manually-uploaded new versions from
-- the original upload.

ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS display_name text;

-- Broaden source to include 'user_upload' for versions the user uploads
-- after the original document creation.
ALTER TABLE public.document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_check;

ALTER TABLE public.document_versions
  ADD CONSTRAINT document_versions_source_check
  CHECK (source = ANY (ARRAY[
    'upload'::text,
    'user_upload'::text,
    'assistant_edit'::text,
    'user_accept'::text,
    'user_reject'::text,
    'generated'::text
  ]));

-- Backfill: default display_name to the parent document's filename. New
-- assistant edits inherit the prior version's display_name (see
-- runEditDocument), so the version number is no longer baked into the
-- default label — it's surfaced as a separate tag in the UI.
DO $$
BEGIN
  -- Later migrations remove documents.filename. Keep this historical
  -- backfill re-runnable against both the old and current schemas.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'documents'
      AND column_name = 'filename'
  ) THEN
    UPDATE public.document_versions dv
    SET display_name = d.filename
    FROM public.documents d
    WHERE dv.display_name IS NULL
      AND d.id = dv.document_id;
  END IF;
END $$;
