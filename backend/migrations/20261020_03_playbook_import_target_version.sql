-- Migration date: 2026-10-20
-- A replacement import records the version of the playbook it replaces (its
-- updated_at when the import began) and saves its compiled content only over
-- that version, so an edit made while it compiles is never silently lost.
-- While such an import runs, content writes to its playbook are refused; the
-- partial index serves that check on every autosave.
alter table public.playbook_imports
  add column if not exists target_updated_at timestamptz;
create index if not exists idx_playbook_imports_running_playbook
  on public.playbook_imports(playbook_id)
  where status = 'running';
