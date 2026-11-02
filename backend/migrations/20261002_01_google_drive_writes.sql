-- Migration date: 2026-10-02
-- Bind Drive approvals to one connection; retain settings across reconnects.
alter table public.user_google_drive_tokens
  add column if not exists grant_id uuid not null default gen_random_uuid(),
  add column if not exists require_write_approval boolean not null default false;

-- complete_google_drive_oauth rotates grant_id on reconnect; it is defined
-- once, in 20261002_02_google_drive_account_email.sql.
