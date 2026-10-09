-- Migration date: 2026-10-09
-- Retain encrypted credentials and model selections while a provider is off.
alter table public.user_api_keys
  add column if not exists enabled boolean not null default true;
