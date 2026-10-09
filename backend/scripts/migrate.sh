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
#                   at the first failure.
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
# every migration it already contains recorded. Do not run two copies of the
# script against one database at the same time. Needs bash 3.2+ and psql.
set -euo pipefail

# The migration that creates the ledger. `baseline` applies it (idempotent)
# when the table does not exist yet.
LEDGER_MIGRATION="20261009_03_schema_migrations.sql"

script_dir="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$script_dir/../migrations}"

usage() {
  sed -n '6,24p' "$0" | sed 's/^# \{0,1\}//'
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

# Inserts the filenames listed in $1 (one per line) without a checksum.
record_unrun() {
  local values
  values="$(sed "s/.*/('&')/" "$1" | paste -sd, -)"
  [ -n "$values" ] || return 0
  psql_db -c "insert into public.schema_migrations (filename)
    values $values on conflict (filename) do nothing"
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
  local newest_applied name path
  newest_applied="$(awk -F'|' '$2 != "" { name = $1 } END { print name }' "$tmp/ledger")"
  if [ -n "$newest_applied" ]; then
    LC_ALL=C awk -v newest="$newest_applied" '$0 < newest' "$tmp/pending" |
      while read -r name; do
        warn "$name sorts before $newest_applied, which is already applied (merged out of order?)"
      done
  fi

  while read -r name; do
    path="$MIGRATIONS_DIR/$name"
    echo "Applying $name"
    # One session: the ledger row is written only if every statement in the
    # file succeeded (ON_ERROR_STOP aborts the script before the insert). Not
    # one transaction, because some migrations manage their own or use
    # CREATE INDEX CONCURRENTLY. psql runs from the migrations directory so
    # \i takes the bare (character-checked) filename and needs no quoting.
    if ! (cd "$MIGRATIONS_DIR" && psql_db -v name="$name" -v checksum="$(sha256 "$path")") <<'SQL'
\i :name
insert into public.schema_migrations (filename, checksum)
  values (:'name', :'checksum')
  on conflict (filename) do nothing;
SQL
    then
      die "$name failed; it and every later migration are still pending"
    fi
  done < "$tmp/pending"
  echo "Applied $(wc -l < "$tmp/pending" | tr -d ' ') migration(s)."
}

cmd_baseline() {
  check_file_arg "${1:-}"
  if ! ledger_exists; then
    echo "Creating public.schema_migrations"
    psql_db -f "$MIGRATIONS_DIR/$LEDGER_MIGRATION"
  fi
  list_files | LC_ALL=C awk -v last="$1" '$0 <= last' > "$tmp/baseline"
  record_unrun "$tmp/baseline"
  echo "Recorded $(wc -l < "$tmp/baseline" | tr -d ' ') migration(s) up to $1 as applied (not run)."
}

cmd_mark() {
  check_file_arg "${1:-}"
  require_ledger
  echo "$1" > "$tmp/mark"
  record_unrun "$tmp/mark"
  echo "Recorded $1 as applied (not run)."
}

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

command="$1"
shift
"cmd_$command" "$@"
