-- Migration date: 2026-10-17
-- A review of a stored document records which document it reviewed and the
-- version holding the review's tracked changes, so the run can show them.
alter table public.playbook_runs
  add column if not exists document_id uuid references public.documents(id) on delete set null,
  add column if not exists edited_version_id uuid references public.document_versions(id) on delete set null;
create index if not exists idx_playbook_runs_document on public.playbook_runs(document_id);

-- A chat message can name the playbook the user picked, like a workflow.
alter table public.chat_messages add column if not exists playbook jsonb;
