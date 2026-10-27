-- Migration date: 2026-10-21
-- Whether the assistant may run Python over a user's documents (Settings >
-- Features). On by default; the deployment can still switch the tool off.
alter table public.user_profiles
  add column if not exists code_analysis boolean not null default true;
