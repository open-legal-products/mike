-- Migration date: 2026-10-02
-- Bind MCP approvals to the authorized account. Interactive authorization
-- rotates this identity; routine token refresh preserves it.
alter table public.user_mcp_oauth_tokens
  add column if not exists grant_id uuid not null default gen_random_uuid();
