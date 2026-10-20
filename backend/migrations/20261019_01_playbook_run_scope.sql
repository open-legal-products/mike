-- Migration date: 2026-10-19
-- A run records whether it reviewed every rule or reported only the issues,
-- so an issues-only run is not mistaken for one that found nothing else.
alter table public.playbook_runs
  add column if not exists review_scope text not null default 'full';
alter table public.playbook_runs
  drop constraint if exists playbook_runs_review_scope_check;
alter table public.playbook_runs
  add constraint playbook_runs_review_scope_check
  check (review_scope in ('full', 'issues'));
