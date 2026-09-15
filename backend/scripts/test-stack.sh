#!/usr/bin/env bash
# Run the gated stack-level integration tests against a local Supabase stack.
#
# These tests exercise the REAL stack (GoTrue auth + Postgres RLS) instead of
# mocks. They are the harness you re-run on every Supabase image bump to prove
# the auth↔API contract and the deny-all RLS firewall still hold.
#
# Usage:  supabase start   # in the repo, once
#         npm run test:stack        (from backend/)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SCHEMA_FILE="$BACKEND_DIR/schema.sql"

if ! command -v supabase >/dev/null 2>&1; then
    echo "supabase CLI not found. Install: brew install supabase/tap/supabase" >&2
    exit 1
fi

STATUS="$(supabase status -o json 2>/dev/null)" || {
    echo "No running Supabase stack. Start one with: supabase start" >&2
    exit 1
}

read_key() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s)['$1']??'')))" <<<"$STATUS"; }

SUPABASE_TEST_URL="$(read_key API_URL)"
SUPABASE_TEST_SERVICE_ROLE_KEY="$(read_key SERVICE_ROLE_KEY)"
SUPABASE_TEST_ANON_KEY="$(read_key ANON_KEY)"
SUPABASE_TEST_DB_URL="$(read_key DB_URL)"

if [[ -z "$SUPABASE_TEST_URL" || -z "$SUPABASE_TEST_SERVICE_ROLE_KEY" || -z "$SUPABASE_TEST_ANON_KEY" || -z "$SUPABASE_TEST_DB_URL" ]]; then
    echo "Could not read API_URL/DB_URL/SERVICE_ROLE_KEY/ANON_KEY from 'supabase status'." >&2
    exit 1
fi
export SUPABASE_TEST_URL SUPABASE_TEST_SERVICE_ROLE_KEY SUPABASE_TEST_ANON_KEY

if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found. Install PostgreSQL's client tools before running stack tests." >&2
    exit 1
fi

# A newly started local stack contains Supabase's system schemas but none of
# Mike's application tables. Initialize only an empty stack: silently resetting
# or modifying an existing application database would be surprising.
PROJECTS_TABLE="$(
    psql "$SUPABASE_TEST_DB_URL" -XAtq \
        -c "select to_regclass('public.projects');"
)"
if [[ "$PROJECTS_TABLE" != "projects" ]]; then
    echo "Mike schema not found; loading $SCHEMA_FILE"
    psql "$SUPABASE_TEST_DB_URL" -X \
        --set ON_ERROR_STOP=1 \
        --file "$SCHEMA_FILE"
fi

echo "Running stack integration tests against $SUPABASE_TEST_URL"
cd "$BACKEND_DIR"
exec npx vitest run src/__tests__/integration/*.supabase.test.ts "$@"
