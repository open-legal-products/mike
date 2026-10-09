#!/usr/bin/env bash
# One-time move of a Compose volume created before the migration ledger
# (backend/migrations/20261009_03_schema_migrations.sql) onto it. Run by
# db-init only when the volume has a schema but no public.schema_migrations.
#
# Before the ledger, db-init could not tell what a volume had applied, so
# every start replayed each migration from 20260823_01 to 20261009_02. A
# failure up to 20260921_01 was ignored (most of those files cannot run a
# second time over their own result), one from 20260921_02 on stopped the
# start, and 20260905_01 was skipped once memory_files existed. This script
# does that replay one last time under the same rules, so a volume last
# started on any older checkout catches up exactly as it used to, then
# records everything up to 20261009_02 as applied. Later files are left to
# `migrate.sh up`.
#
# Environment: DB and MIGRATIONS_DIR as in db-init, and MIGRATE_SH, the path
# of backend/scripts/migrate.sh (default /migrate.sh).
set -uo pipefail

FIRST_REPLAYED=20260823_01
FAIL_CLOSED_FROM=20260921_02
LAST_REPLAYED=20261009_02_user_api_key_enabled.sql

has_memory_files=false
if psql "$DB" -tAc "select to_regclass('public.memory_files')" | grep -q memory_files; then
  has_memory_files=true
fi

# Byte-order comparisons (LC_ALL=C), as `LC_ALL=C sort` orders migrations.
replayed="$(cd "$MIGRATIONS_DIR" && ls -1 -- *.sql | LC_ALL=C sort |
  LC_ALL=C awk -v first="$FIRST_REPLAYED" -v last="$LAST_REPLAYED" '$0 >= first && $0 <= last')"
fail_closed="$(printf '%s\n' "$replayed" | LC_ALL=C awk -v from="$FAIL_CLOSED_FROM" '$0 >= from')"

for name in $replayed; do
  if [ "$name" = 20260905_01_scoped_memory_files.sql ] && $has_memory_files; then
    continue
  fi
  echo "Replaying $name"
  if ! psql "$DB" -v ON_ERROR_STOP=1 -f "$MIGRATIONS_DIR/$name"; then
    if printf '%s\n' "$fail_closed" | grep -Fqx "$name"; then
      exit 1
    fi
    echo "Ignoring the failure, as db-init always has for this file."
  fi
done

bash "${MIGRATE_SH:-/migrate.sh}" baseline "$LAST_REPLAYED"
