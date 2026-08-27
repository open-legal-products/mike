#!/usr/bin/env bash
# Boot the full local e2e stack and run the Playwright suite.
#
# Local-machine mirror of .github/workflows/e2e.yml: starts the Supabase CLI
# stack (Docker), loads backend/schema.sql + backend/migrations/ (re-granting
# service_role's narrowed privileges afterwards for migration-created tables —
# see docs/e2e-ci.md), points backend/.env and frontend/.env.local at the
# local stack, then runs `npx playwright test`.
#
# Usage, from the repo root:
#   npm run test:e2e:local            # whole suite
#   npm run test:e2e:local -- -g "display name"   # extra args go to Playwright
#
# With --setup-only the script prepares the stack and exits without running
# Playwright — playwright.config.ts uses this in the backend webServer command
# so a plain `npm run test:e2e` also boots against a ready local stack.
#
# The first run rewrites the Supabase lines in your env files; the previous
# (e.g. hosted) versions are kept once as .env.hosted.bak / .env.local.hosted.bak.
# Restore those backups to point back at the hosted project.
set -euo pipefail

SETUP_ONLY=0
if [ "${1:-}" = "--setup-only" ]; then
    SETUP_ONLY=1
    shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running — start it first (open -a Docker) and retry." >&2
    exit 1
fi

cd "$BACKEND"

if [ ! -f supabase/config.toml ]; then
    npx supabase init --force --with-vscode-settings=false ||
        npx supabase init --force
fi

# Idempotent: if the stack is already up this is a no-op.
npx supabase start

STATUS=$(npx supabase status -o json)
DB_URL=$(jq -r '.DB_URL' <<<"$STATUS")
API_URL=$(jq -r '.API_URL' <<<"$STATUS")
ANON_KEY=$(jq -r '.ANON_KEY' <<<"$STATUS")
SERVICE_KEY=$(jq -r '.SERVICE_ROLE_KEY' <<<"$STATUS")

# schema.sql is not idempotent, so only load it into a virgin database; the
# dated migrations ARE re-runnable and fill any gap schema.sql has (it lags —
# see docs/e2e-ci.md), so apply them every time.
if [ "$(psql "$DB_URL" -tAc "SELECT to_regclass('public.user_profiles') IS NULL")" = "t" ]; then
    echo "Loading schema.sql into fresh database…"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f schema.sql
fi
for m in migrations/*.sql; do
    psql "$DB_URL" -q -f "$m" >/dev/null 2>&1 ||
        echo "warning: migration returned non-zero (already applied?): $m"
done
# schema.sql grants these itself, but only for tables that existed when it
# ran — re-grant after migrations, with the same narrowed set (not ALL).
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
NOTIFY pgrst, 'reload schema';
SQL

# Rewrite only the Supabase lines of the env files, preserving everything else
# (API keys, R2 storage, …). Keep a one-time backup of the pre-local versions.
set_kv() {
    local file=$1 key=$2 value=$3
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        awk -v k="$key" -v v="$value" \
            'index($0, k"=") == 1 { print k "=" v; next } { print }' \
            "$file" >"$file.tmp" && mv "$file.tmp" "$file"
    else
        echo "${key}=${value}" >>"$file"
    fi
}

[ -f .env ] || cp .env.example .env
[ -f .env.hosted.bak ] || cp .env .env.hosted.bak
set_kv .env SUPABASE_URL "$API_URL"
set_kv .env SUPABASE_PUBLISHABLE_KEY "$ANON_KEY"
set_kv .env SUPABASE_SECRET_KEY "$SERVICE_KEY"
# The suite fires well over the backend's default 300-requests/15-min general
# cap in one run; once tripped every call 429s and profile/list waits time out.
# Same overrides CI uses — e2e is not testing throttling.
set_kv .env RATE_LIMIT_GENERAL_MAX 100000
set_kv .env RATE_LIMIT_CHAT_MAX 100000
set_kv .env RATE_LIMIT_CHAT_CREATE_MAX 100000
set_kv .env RATE_LIMIT_EXPORT_MAX 100000
set_kv .env RATE_LIMIT_DATA_DELETE_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_POLL_MAX 100000
set_kv .env RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR 100000

touch "$FRONTEND/.env.local"
[ -f "$FRONTEND/.env.local.hosted.bak" ] || cp "$FRONTEND/.env.local" "$FRONTEND/.env.local.hosted.bak"
set_kv "$FRONTEND/.env.local" API_BASE_URL "http://localhost:3001"

echo "Local stack ready: $API_URL (db: ${DB_URL%%\?*})"

if [ "$SETUP_ONLY" = "1" ]; then
    exit 0
fi

echo "NOTE: kill any backend/frontend dev servers started before this script —"
echo "they hold the old env. playwright.config.ts starts fresh ones if none run."

cd "$ROOT"
npx playwright test "$@"
