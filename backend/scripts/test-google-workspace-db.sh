#!/usr/bin/env bash
# No existing database or host ports are used. The throwaway container is removed.
set -euo pipefail
workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
workspace_container="mike-google-workspace-test-$$"
cleanup() { docker rm -f "$workspace_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --name "$workspace_container" -d -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
workspace_ready=false
for _ in $(seq 1 30); do
  # The image starts a socket-only temporary server while initializing. Waiting
  # for TCP avoids racing its shutdown before the final server starts.
  if docker exec "$workspace_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    workspace_ready=true
    break
  fi
  sleep 1
done
if [ "$workspace_ready" != true ]; then
  docker logs "$workspace_container" >&2
  exit 1
fi
sql() { docker exec -i "$workspace_container" psql -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 -U postgres; }
sql <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create table public.user_mcp_connectors(id uuid primary key, require_write_approval boolean not null default false);
SQL
for migration in 20260921_02_google_drive_integration.sql 20260922_01_google_workspace.sql 20261001_01_connector_write_access.sql 20261002_01_google_drive_writes.sql 20261002_02_google_drive_account_email.sql 20261002_03_connector_read_only.sql; do
  # Each migration must be safe to replay.
  sql < "$workspace_root/backend/migrations/$migration"
  sql < "$workspace_root/backend/migrations/$migration"
done
sql < "$workspace_root/backend/src/lib/integrations/__tests__/googleWorkspaceDatabase.sql" >/dev/null
echo 'Google Workspace database authorization, lifecycle, settings, and migration replay passed.'
