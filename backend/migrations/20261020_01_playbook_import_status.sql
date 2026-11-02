-- Migration date: 2026-10-20
-- A playbook import compiles apart from the request that started it, so the
-- page can be left and come back. The attempt row is what the page reads to
-- follow it; it records the workspace so only that workspace shows it.
alter table public.playbook_imports
  add column if not exists org_id uuid references public.organizations(id) on delete cascade;
create index if not exists idx_playbook_imports_user_status
  on public.playbook_imports(user_id, status, started_at desc);
