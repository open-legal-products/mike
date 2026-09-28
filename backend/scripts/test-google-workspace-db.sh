#!/usr/bin/env bash
# No existing database or host ports are used. The throwaway container is removed.
set -euo pipefail
workspace_root="$(cd "$(dirname "$0")/../.." && pwd)"
workspace_container="mike-google-workspace-test-$$"
workspace_results="$(mktemp -d)"
cleanup() { docker rm -f "$workspace_container" >/dev/null 2>&1 || true; rm -rf "$workspace_results"; }
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
SQL
sql < "$workspace_root/backend/migrations/20260922_01_google_workspace.sql"
sql < "$workspace_root/backend/migrations/20260922_01_google_workspace.sql"
sql < "$workspace_root/backend/src/lib/integrations/__tests__/googleWorkspaceDatabase.sql" > "$workspace_results/assertions"
claim="select public.claim_google_workspace_action('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003') is not null;"
docker exec "$workspace_container" psql -h 127.0.0.1 -XAtq -v ON_ERROR_STOP=1 -U postgres -c "begin; select 1 from auth.users where id='00000000-0000-0000-0000-000000000001' for update; select pg_sleep(0.5); $claim commit;" > "$workspace_results/first" &
workspace_first=$!
docker exec "$workspace_container" psql -h 127.0.0.1 -XAtq -v ON_ERROR_STOP=1 -U postgres -c "$claim" > "$workspace_results/second" &
workspace_second=$!
wait "$workspace_first"; wait "$workspace_second"
python3 - "$workspace_results" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);out=(p/'first').read_text().splitlines()+(p/'second').read_text().splitlines()
assert out.count('t')==1 and out.count('f')==1, out
print('Google Workspace database authorization, lifecycle, migration replay, and concurrent claims passed.')
PY
