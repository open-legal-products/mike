-- Migration date: 2026-10-18
-- The sidebar's History pages through a person's playbook runs, newest first.
create index if not exists idx_playbook_runs_user_started
  on public.playbook_runs(user_id, started_at desc);
