# Stored document text and agent search

Every live document version has a derived text record in `document_version_texts`.
Uploading a version or changing its source path, content hash, or file type queues
`document.extract_text` in the same transaction. A two-second delay coalesces rapid
saves: superseded jobs skip extraction. Repeated agent edits write immutable source objects and atomically update the
version path and hash, so extraction never races an in-place overwrite. Version
activation reuses that version's text. Renames and PDF-rendition updates do not invalidate it.

The worker uses the existing PDF, accepted-view DOCX, spreadsheet, and presentation
readers. Legacy DOC/PPT use LibreOffice. Text is complete, with existing page,
slide, and spreadsheet markers. PostgreSQL cannot store NUL, so those characters
are removed. Scanned pages are reported as incomplete OCR coverage; this feature
does not add OCR. Extraction failures are distinct from successful empty text.

Each source mutation changes `document_versions.text_revision`. Publication locks
and compares that revision, so late jobs cannot overwrite an edit, repopulate a
deleted version, or invalidate a newer success. Replacing bytes within a version
updates that version's derived text; separately saved historical versions retain
their own text. Soft-deleting a version removes its text; hard deletion cascades.

## Agent tools

`find_documents` searches the current conversation workspace, with scopes
`project` (the conversation's project), `library` (the caller's Library Files),
`templates` (the caller's Library Templates), and `document` (a handle or UUID).
Current versions are searched by default. An explicit `version_id` with document
scope searches history. Existing sharing, organization, and archive rules apply
before both counts and excerpts are returned. A service-only RPC accepts the
server's actor identity; clients cannot call it with another user's ID.

Queries are literal and case-insensitive, including literal whitespace and
punctuation. They are 2–500 characters, with 1–20 matching documents per page.
PostgreSQL's existing pg_trgm extension indexes substring matching. Very short
queries can scan broadly. Each result includes the first matching excerpt,
version/revision, and zero-based Unicode character offsets. Follow `next_offset`
for more documents. Offsets paginate documents, not individual occurrences; use
`find_in_document` for all occurrences in a selected result.

Results create handles for `read_document` and `find_in_document`. These read the
stored text, reauthorize access, and refuse an obsolete revision without falling
back to old storage bytes. Template handles retain the copy-before-edit rule.
`coverage` includes total, indexed, pending, failed, and OCR-incomplete versions;
zero matches must not be treated as proof that a clause is absent.

## Rollout and recovery

Apply `20261015_01_document_text_search.sql` using the normal migration runner,
then deploy the backend/worker together. The migration queues up to 100 existing
versions. The maintenance sweep, first run about 30 seconds after worker startup
and normally every ten minutes, resumes another batch of 100, prioritizing
current versions before history. Live jobs deduplicate overlapping sweeps.
Archived documents are excluded until restored; deleted versions stay excluded.

The queue retries failures three times with its standard backoff. A terminal
failure remains visible in the text record after job retention expires. To queue
an additional bounded batch (up to 500), or explicitly retry terminal failures:

```sh
npm run build --prefix backend
npm run backfill:document-text --prefix backend
npm run backfill:document-text --prefix backend -- --retry-failed
```

Run these only against the intended deployment. Repeat batches to accelerate a
large backfill. No embeddings, new dependencies, or separate search server are
required. `DB_JOBS_ENABLED=false` processes new lifecycle writes inline and up to
five queued jobs per maintenance sweep; normal deployments should keep workers on.

## Verification

Unit tests cover extractors, stale jobs, failure handling, input bounds, and agent
handles. `documents.textSearch.sql` exercises actual PostgreSQL triggers, scoped
search, version publication, backfill and permissions in rolled-back transactions.
Run the opt-in PostgreSQL Vitest wrapper with `MIKE_TEST_POSTGRES_CONTAINER` pointing
to a disposable local Supabase container; it creates and drops its own database.
