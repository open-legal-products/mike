-- Migration date: 2026-09-20
-- Managed USPTO Patent & Trademark connector:
--   1. Per-user feature switch (default off).
--   2. stdio transport, allowed only for the managed USPTO identity with
--      auth_type 'none'.
--   3. One managed USPTO connector per user (partial unique index) so
--      concurrent provisioning collapses onto a single row.
-- Rollback note: remove or convert stdio rows before restoring the old
-- transport check.

alter table public.user_profiles
  add column if not exists uspto_connector_enabled boolean not null default false;

alter table public.user_mcp_connectors
  drop constraint if exists user_mcp_connectors_transport_check;

alter table public.user_mcp_connectors
  add constraint user_mcp_connectors_transport_check
  check (
    transport = 'streamable_http'
    or (
      transport = 'stdio'
      and server_url = 'builtin://patent-mcp-server'
      and auth_type = 'none'
    )
  );

create unique index if not exists user_mcp_connectors_managed_patent_uidx
  on public.user_mcp_connectors (user_id)
  where transport = 'stdio' and server_url = 'builtin://patent-mcp-server';
