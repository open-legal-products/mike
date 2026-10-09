-- Migration date: 2026-10-09
-- A ledger of the files in backend/migrations/ that this database has
-- applied, one row per filename, so an operator no longer has to keep "the
-- last migration I ran" in their own notes. backend/scripts/migrate.sh reads
-- it to decide what is pending and appends a row after each file it applies.
--
-- This migration only creates the table: it cannot know which earlier files
-- an existing deployment really applied. After applying it, record that with
-- `backend/scripts/migrate.sh baseline <last file applied>` (normally this
-- file's own name); see docs/deployment.md. Fresh installs get the table from
-- schema.sql already filled in.
--
-- checksum is the file's sha256 when the runner applied it, and null for rows
-- recorded without running the file (schema.sql, `baseline`, `mark`).
create table if not exists public.schema_migrations (
  filename text primary key,
  checksum text,
  applied_at timestamptz not null default now()
);

-- Operator bookkeeping only: the runner connects as the database owner, and
-- no application role reads or writes it. service_role is revoked by name
-- because `migrate.sh baseline` can create this table before an older
-- migration that grants service_role every table in public
-- (20260805_01_narrow_service_role_grants.sql) runs; re-applying this file
-- afterwards takes the grant back.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated, service_role;
