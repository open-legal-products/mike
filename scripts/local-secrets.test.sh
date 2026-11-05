#!/usr/bin/env bash
# Regression test for scripts/lib/local-secrets.sh. No Docker needed.
#
#   bash scripts/local-secrets.test.sh
#
# The e2e setup script runs under `set -euo pipefail`. Filling the throwaway
# secrets must not abort when an existing backend/.env lacks one of the keys
# (grep exits 1 on no match), must replace the template placeholders, and
# must keep a real value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/local-secrets.sh
. "$ROOT/scripts/lib/local-secrets.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/local-secrets-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
value_of() { env_value "$WORK/.env" "$1"; }

# 1. An existing .env without either key: the script must survive and fill both.
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' >"$WORK/.env"
fill_placeholder_secrets "$WORK/.env"
[ "$(value_of DOWNLOAD_SIGNING_SECRET)" = "ci-download-signing-secret-0123456789abcdef" ] \
    || fail "missing DOWNLOAD_SIGNING_SECRET was not filled"
[ "$(value_of USER_API_KEYS_ENCRYPTION_SECRET)" = "ci-user-api-keys-encryption-secret-0123456789abcdef" ] \
    || fail "missing USER_API_KEYS_ENCRYPTION_SECRET was not filled"
[ "$(value_of SUPABASE_URL)" = "http://127.0.0.1:54321" ] || fail "unrelated line was changed"

# 2. The template placeholders are replaced in place.
printf 'DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string\nUSER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret\n' >"$WORK/.env"
fill_placeholder_secrets "$WORK/.env"
[ "$(value_of DOWNLOAD_SIGNING_SECRET)" = "ci-download-signing-secret-0123456789abcdef" ] \
    || fail "placeholder DOWNLOAD_SIGNING_SECRET was not replaced"
[ "$(grep -c '^DOWNLOAD_SIGNING_SECRET=' "$WORK/.env")" = "1" ] || fail "placeholder was appended instead of replaced"

# 3. A real value is kept, and an empty assignment counts as missing.
printf 'DOWNLOAD_SIGNING_SECRET=operator-set-value-left-alone\nUSER_API_KEYS_ENCRYPTION_SECRET=\n' >"$WORK/.env"
fill_placeholder_secrets "$WORK/.env"
[ "$(value_of DOWNLOAD_SIGNING_SECRET)" = "operator-set-value-left-alone" ] \
    || fail "a real DOWNLOAD_SIGNING_SECRET was overwritten"
[ "$(value_of USER_API_KEYS_ENCRYPTION_SECRET)" = "ci-user-api-keys-encryption-secret-0123456789abcdef" ] \
    || fail "empty USER_API_KEYS_ENCRYPTION_SECRET was not filled"

echo "local-secrets: all checks passed"
