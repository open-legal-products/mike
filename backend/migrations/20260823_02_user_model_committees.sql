-- Migration date: 2026-08-23
-- Per-user model committees, managed from Settings > Models.

alter table public.user_profiles
  add column if not exists model_committees jsonb not null default '[]'::jsonb;
