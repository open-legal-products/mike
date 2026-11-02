-- Migration date: 2026-09-30

-- Match the backend-only access model used by the other application tables.
-- No client policies: only the backend service role may access these rows.
alter table public.default_workflow_installations enable row level security;
alter table public.quick_actions enable row level security;

revoke all on public.default_workflow_installations from public, anon, authenticated;
revoke all on public.quick_actions from public, anon, authenticated;

grant select, insert, update, delete
  on public.default_workflow_installations, public.quick_actions
  to service_role;
