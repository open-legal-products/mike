-- Migration date: 2026-10-02
-- A connector-wide override preserves individual tool settings underneath it.
alter table public.user_mcp_connectors
  add column if not exists read_only boolean not null default false;
alter table public.user_google_drive_tokens
  add column if not exists read_only boolean not null default false;
alter table public.user_google_workspace_tokens
  add column if not exists read_only boolean not null default false;
