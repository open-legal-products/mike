#!/usr/bin/env bash
# Apply backend/migrations/ to an existing database, recording each file in
# the public.schema_migrations ledger so the database itself knows which
# migrations it has run.
#
# Usage:
#   DATABASE_URL=postgres://... backend/scripts/migrate.sh <command>
#
# Commands:
#   status          List pending migrations. Exits 0 when the database is up
#                   to date and 2 when files are pending.
#   up              Apply every pending migration in filename order, stopping
#                   at the first failure. Each file runs in one transaction
#                   with its ledger row, unless it cannot (see
#                   runs_in_transaction below).
#   baseline FILE   Record FILE and every migration that sorts before it as
#                   applied, without running them. Run once to adopt the
#                   ledger on a deployment upgraded by hand: FILE is the last
#                   migration it applied. Creates the ledger table if needed.
#   mark FILE       Record one migration as applied without running it, for
#                   a file applied by hand (for example in the SQL editor).
#
# Environment:
#   DATABASE_URL    Connection string for a role that owns the public schema
#                   (on Supabase, the `postgres` direct or session-pooler URL).
#   MIGRATIONS_DIR  Defaults to backend/migrations beside this script.
#
# Fresh installs do not need this script: schema.sql creates the ledger with
# every migration it already contains recorded. Runs against one database
# queue on an advisory lock, so a second `up` waits for the first and then
# skips what it applied. Needs bash 3.2+ and psql 10+.
set -euo pipefail

# The migration that creates the ledger. `baseline` applies it (idempotent)
# when the table does not exist yet.
LEDGER_MIGRATION="20261009_03_schema_migrations.sql"

# Session-level advisory lock taken by every command that writes the ledger.
# It is released when psql disconnects, including when a migration fails or
# the script is killed. Needs a session (not a transaction-pooler) connection.
LOCK_KEY="hashtextextended('mike/backend/scripts/migrate.sh', 0)"

script_dir="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$script_dir/../migrations}"

usage() {
  sed -n '6,26p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "migrate: $*" >&2
  exit 1
}

warn() {
  echo "migrate: warning: $*" >&2
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

psql_db() {
  psql -d "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
}

query() {
  psql_db -At -F '|' "$@"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# Every migration file, in the order they are applied: byte order, so every
# comparison below runs under LC_ALL=C too (but only that command, since the
# locale also sets psql's client encoding). Names are restricted
# to a safe character set so they can be written into SQL literals and the
# '|'-separated ledger listing without escaping.
list_files() {
  local path name
  for path in "$MIGRATIONS_DIR"/*.sql; do
    [ -f "$path" ] || continue
    name="${path##*/}"
    case "$name" in
      *[!A-Za-z0-9_.-]*) die "unexpected characters in migration filename: $name" ;;
    esac
    echo "$name"
  done | LC_ALL=C sort
}

ledger_exists() {
  local exists
  exists="$(query -c "select to_regclass('public.schema_migrations') is not null")" ||
    die "could not query the database at DATABASE_URL"
  [ "$exists" = "t" ]
}

require_ledger() {
  ledger_exists && return 0
  die "public.schema_migrations does not exist yet. Record what this database
has already applied first:

  $0 baseline <last migration file this database applied>

See \"Database setup\" in docs/deployment.md."
}

# Writes $tmp/files (directory), $tmp/ledger (filename|checksum rows),
# $tmp/applied (ledger filenames) and $tmp/pending (files not in the ledger),
# and warns about ledger rows that no longer match the directory.
load_state() {
  list_files > "$tmp/files"
  query -c "select filename, coalesce(checksum, '') from public.schema_migrations order by filename" > "$tmp/ledger"
  cut -d'|' -f1 "$tmp/ledger" > "$tmp/applied"
  grep -Fvx -f "$tmp/applied" "$tmp/files" > "$tmp/pending" || true

  local name checksum
  while IFS='|' read -r name checksum; do
    if [ ! -f "$MIGRATIONS_DIR/$name" ]; then
      warn "$name is recorded as applied but is not in $MIGRATIONS_DIR (renamed or removed?)"
    elif [ -n "$checksum" ] && [ "$checksum" != "$(sha256 "$MIGRATIONS_DIR/$name")" ]; then
      warn "$name has changed since it was applied"
    fi
  done < "$tmp/ledger"
}

check_file_arg() {
  [ -n "${1:-}" ] || die "missing migration filename (see --help)"
  case "$1" in
    */*) die "pass a filename, not a path: ${1##*/}" ;;
  esac
  list_files | grep -Fqx "$1" || die "no migration named $1 in $MIGRATIONS_DIR"
}

# Prints psql commands that take the migration lock, or, when another run
# holds it, create $tmp/busy and quit. Waiting is done by retrying from bash
# instead of in pg_advisory_lock(): a session blocked there holds a snapshot,
# and CREATE INDEX CONCURRENTLY in the run holding the lock waits for every
# snapshot in the database to finish, so the two would deadlock.
lock_sql() {
  cat <<SQL
select pg_try_advisory_lock($LOCK_KEY) as migrate_locked \gset
\if :migrate_locked
\else
\! touch '$tmp/busy'
\q
\endif
SQL
}

# Runs psql commands from stdin in one session that holds the lock, from the
# migrations directory so \i takes a bare (character-checked) filename.
run_locked() {
  { lock_sql; cat; } > "$tmp/script.sql"
  local said_waiting=false
  while :; do
    rm -f "$tmp/busy"
    (cd "$MIGRATIONS_DIR" && psql_db -f "$tmp/script.sql") || return 1
    [ -e "$tmp/busy" ] || return 0
    if ! $said_waiting; then
      echo "migrate: another migrate.sh run holds the lock on this database; waiting for it"
      said_waiting=true
    fi
    sleep 2
  done
}

# Prints an insert recording the filenames listed in $1 (one per line)
# without a checksum.
record_unrun_sql() {
  local values
  values="$(sed "s/.*/('&')/" "$1" | paste -sd, -)"
  [ -n "$values" ] || return 0
  echo "insert into public.schema_migrations (filename)
  values $values on conflict (filename) do nothing;"
}

# Whether migration file $1 runs inside one transaction with its ledger row,
# so a failure leaves nothing half applied. Files opt out when they cannot:
# with a line reading exactly `-- migrate:no-transaction`, by managing their
# own transaction (a begin/commit/rollback/start transaction statement on a
# line of its own), or by using CONCURRENTLY, which PostgreSQL refuses inside
# a transaction block. The last two are detected so that shipped migrations,
# which must not be edited, need no marker.
runs_in_transaction() {
  ! grep -Eiq \
    -e '^-- migrate:no-transaction[[:space:]]*$' \
    -e '^[[:space:]]*(begin|commit|rollback|start[[:space:]]+transaction)([[:space:]]+(transaction|work))?[[:space:]]*;' \
    -e 'concurrently' \
    "$1"
}

cmd_status() {
  require_ledger
  load_state
  local pending
  pending="$(wc -l < "$tmp/pending" | tr -d ' ')"
  echo "$(wc -l < "$tmp/applied" | tr -d ' ') recorded, $pending pending"
  sed 's/^/  pending: /' "$tmp/pending"
  [ "$pending" -eq 0 ] || exit 2
}

cmd_up() {
  require_ledger
  load_state
  if [ ! -s "$tmp/pending" ]; then
    echo "Up to date."
    return 0
  fi

  # Only rows this script applied (they carry a checksum) count: a baseline
  # or mark legitimately records files ahead of ones still pending.
  local newest_applied name path begin commit note
  newest_applied="$(awk -F'|' '$2 != "" { name = $1 } END { print name }' "$tmp/ledger")"
  if [ -n "$newest_applied" ]; then
    LC_ALL=C awk -v newest="$newest_applied" '$0 < newest' "$tmp/pending" |
      while read -r name; do
        warn "$name sorts before $newest_applied, which is already applied (merged out of order?)"
      done
  fi

  # The pending list was read before taking the lock, so each file is checked
  # against the ledger again under it: a run that waited skips whatever the
  # run it waited for applied. ON_ERROR_STOP ends the session at the first
  # failure, rolling back that file's transaction (if it has one) and
  # releasing the lock. RESET ALL gives each file the session settings a
  # fresh connection would have.
  while read -r name; do
    path="$MIGRATIONS_DIR/$name"
    if runs_in_transaction "$path"; then
      begin="begin;" commit="commit;" note=""
    else
      begin="" commit="" note=" (no transaction)"
    fi
    cat <<SQL
select exists (select 1 from public.schema_migrations where filename = '$name') as migrate_done \gset
\if :migrate_done
\echo 'Skipping $name: another run applied it'
\else
\echo 'Applying $name$note'
$begin
\i $name
insert into public.schema_migrations (filename, checksum)
  values ('$name', '$(sha256 "$path")');
$commit
reset all;
\endif
SQL
  done < "$tmp/pending" > "$tmp/up.sql"

  if ! run_locked < "$tmp/up.sql"; then
    list_files > "$tmp/files"
    query -c "select filename from public.schema_migrations" > "$tmp/applied" ||
      die "the database connection failed; run status to see what is still pending"
    name="$(grep -Fvx -f "$tmp/applied" "$tmp/files" | head -n 1 || true)"
    die "${name:-a migration} failed; it and every later migration are still pending"
  fi
  echo "Up to date."
}

cmd_baseline() {
  check_file_arg "${1:-}"
  list_files | LC_ALL=C awk -v last="$1" '$0 <= last' > "$tmp/baseline"
  {
    echo "select to_regclass('public.schema_migrations') is null as migrate_no_ledger \gset"
    echo "\if :migrate_no_ledger"
    echo "\echo 'Creating public.schema_migrations'"
    echo "\i $LEDGER_MIGRATION"
    echo "\endif"
    record_unrun_sql "$tmp/baseline"
  } | run_locked
  echo "Recorded $(wc -l < "$tmp/baseline" | tr -d ' ') migration(s) up to $1 as applied (not run)."
}

cmd_mark() {
  check_file_arg "${1:-}"
  require_ledger
  echo "$1" > "$tmp/mark"
  record_unrun_sql "$tmp/mark" | run_locked
  echo "Recorded $1 as applied (not run)."
}

main() {
  case "${1:-}" in
    -h | --help | help) usage; exit 0 ;;
    status | up | baseline | mark) ;;
    "") usage >&2; exit 1 ;;
    *) die "unknown command: $1 (see --help)" ;;
  esac

  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
  [ -d "$MIGRATIONS_DIR" ] || die "no migrations directory at $MIGRATIONS_DIR"
  MIGRATIONS_DIR="$(cd "$MIGRATIONS_DIR" && pwd)"
  command -v psql >/dev/null 2>&1 || die "psql is not installed"

  local command="$1"
  shift
  "cmd_$command" "$@"
}

# Sourcing the script (as its tests do) defines the functions without running.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
