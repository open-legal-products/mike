#!/usr/bin/env bash
# Start the backend image on Vercel (docs/vercel.md).
#
# Usage: vercel-start.sh api|worker
#
# The Vercel deployment has no compose file and no operator shell, so this
# script does the work docker-compose.yml and docs/deployment.md leave to the
# operator, then execs the real process:
#
#   1. Reads the Supabase Marketplace integration's variable names
#      (SUPABASE_SERVICE_ROLE_KEY, POSTGRES_URL_NON_POOLING, ...) into the
#      ones Mike uses. A variable already set on the project always wins.
#   2. Derives FRONTEND_URL and API_PUBLIC_URL from the production domain
#      Vercel assigns, and selects Supabase Storage when no S3 bucket is
#      configured.
#   3. Sets up the database the way compose's db-init does: schema.sql on a
#      new database, then every pending migration (scripts/migrate.sh), under
#      an advisory lock so the API and the worker can start together.
#   4. Creates the private storage bucket, and generates the backend's own
#      signing/encryption secrets once, keeping them in a schema PostgREST
#      does not expose, so they survive redeploys and are never in the repo.
#   5. Creates the deployer's account (scripts/vercel-admin-user.mjs).
#
# Every step is idempotent; a start with nothing to do costs a few queries.
set -euo pipefail

role="${1:-api}"
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$app_dir"

log() { echo "vercel-start[$role]: $*"; }
die() { log "$*" >&2; exit 1; }

# First non-empty variable among the names given.
first_set() {
  local name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      printf '%s' "${!name}"
      return
    fi
  done
}

# --- 1. Supabase integration names -> Mike names ----------------------------
export SUPABASE_URL="${SUPABASE_URL:-$(first_set NEXT_PUBLIC_SUPABASE_URL)}"
export SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY:-$(first_set SUPABASE_SERVICE_ROLE_KEY)}"
export SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-$(first_set \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY)}"
# migrate.sh needs a session connection (advisory locks), never the
# transaction pooler POSTGRES_URL points at.
export DATABASE_URL="${DATABASE_URL:-$(first_set POSTGRES_URL_NON_POOLING)}"

[ -n "$SUPABASE_URL" ] || die "SUPABASE_URL is not set. Connect a Supabase project to this Vercel project (Storage tab)."
[ -n "$SUPABASE_SECRET_KEY" ] || die "SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is not set."
[ -n "$DATABASE_URL" ] || die "DATABASE_URL (or POSTGRES_URL_NON_POOLING) is not set."

# --- 2. Public URLs and storage ---------------------------------------------
if [ -z "${FRONTEND_URL:-}" ] && [ -n "${VERCEL_PROJECT_PRODUCTION_URL:-}" ]; then
  export FRONTEND_URL="https://${VERCEL_PROJECT_PRODUCTION_URL}"
fi
if [ -z "${API_PUBLIC_URL:-}" ] && [ -n "${FRONTEND_URL:-}" ]; then
  export API_PUBLIC_URL="${FRONTEND_URL%/}/api"
fi
if [ -z "${STORAGE_DRIVER:-}" ] && [ -z "${R2_ENDPOINT_URL:-}" ]; then
  export STORAGE_DRIVER=supabase
fi
bucket="${SUPABASE_STORAGE_BUCKET:-mike}"

# --- 3. Database ------------------------------------------------------------
psql_db() {
  psql -d "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
}

# One session holds the lock while it decides whether the database is new and
# loads schema.sql if so; a second instance waits here, then sees the schema.
log "checking database schema"
psql_db -v schema_file="$app_dir/schema.sql" <<'SQL'
select pg_advisory_lock(2026111701);
select to_regclass('public.user_profiles') is null as fresh \gset
\if :fresh
  \echo 'vercel-start: new database, loading schema.sql'
  \i :schema_file
\endif
select pg_advisory_unlock(2026111701);
SQL

MIGRATIONS_DIR="$app_dir/migrations" bash "$app_dir/scripts/migrate.sh" up

# --- 4. Bucket, grants and generated secrets --------------------------------
psql_db -v bucket="$bucket" <<'SQL'
insert into storage.buckets (id, name, public)
values (:'bucket', :'bucket', false)
on conflict (id) do nothing;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

create schema if not exists mike_deploy;
revoke all on schema mike_deploy from public;
do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on schema mike_deploy from anon, authenticated, service_role;
  end if;
end $$;
create table if not exists mike_deploy.secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
-- gen_random_uuid() draws from the server's strong random source; two of
-- them are 244 random bits, well over the 32 characters the backend wants.
insert into mike_deploy.secrets (name, value)
select name, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
from unnest(array['DOWNLOAD_SIGNING_SECRET', 'USER_API_KEYS_ENCRYPTION_SECRET']) as name
on conflict (name) do nothing;

notify pgrst, 'reload schema';
SQL

while IFS='|' read -r name value; do
  [ -n "$name" ] || continue
  if [ -z "${!name:-}" ]; then
    export "$name=$value"
  fi
done < <(psql_db -At -F '|' -c "select name, value from mike_deploy.secrets")

# --- 5. First account ------------------------------------------------------
node scripts/vercel-admin-user.mjs || true

# --- 6. Run -----------------------------------------------------------------
case "$role" in
  api)
    # Vercel routes /api/* here with the prefix intact; the backend's routes
    # are mounted at the root (docker-compose puts the Next gateway in front).
    export API_PATH_PREFIX="${API_PATH_PREFIX:-/api}"
    # A container service listens on port 80 unless PORT says otherwise.
    export PORT="${PORT:-80}"
    # The worker daemon owns background jobs, but the API also runs them in a
    # worker thread while it is up: Daemons stop when a Hobby plan's monthly
    # quota runs out, and work is partitioned between instances, never
    # duplicated (docs/deployment.md, "Background jobs and Redis").
    export WORKERS_MODE="${WORKERS_MODE:-thread}"
    log "starting API on port $PORT"
    exec node --enable-source-maps dist/index.js
    ;;
  worker)
    log "syncing the workflow catalog"
    node --enable-source-maps dist/jobs/syncWorkflows.js \
      || log "workflow catalog sync failed; continuing (built-in workflows may be missing until the next start)"
    log "starting background workers"
    exec node --enable-source-maps dist/worker.js
    ;;
  *)
    die "unknown role '$role' (expected api or worker)"
    ;;
esac
