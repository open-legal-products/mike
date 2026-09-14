#!/usr/bin/env bash
# Fetch the native service binaries the self-contained local stack runs:
#   Postgres 17 (zonky embedded-postgres build, via npm — same artifact the
#   packaged app bundles), PostgREST, and GoTrue (supabase/auth) — all pinned
#   to the versions docker-compose.yml pins, all official upstream builds,
#   all darwin/arm64.
#
# Output layout (gitignored; packaged as extraResources by electron-builder):
#   local-stack/bin/pg/{bin,lib,share}   postgres, initdb, pg_ctl, psql, ...
#   local-stack/bin/postgrest
#   local-stack/bin/gotrue
set -euo pipefail
cd "$(dirname "$0")/.."

# Pins. PG tracks supabase/postgres:17.x from docker-compose.yml (zonky has no
# 17.6 darwin build; any 17.x is wire- and dump-compatible). The other two
# match the compose image tags exactly.
PG_NPM_VERSION="17.10.0-beta.17"
POSTGREST_VERSION="v14.12"
GOTRUE_VERSION="v2.189.0"

DEST="local-stack/bin"
mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Postgres $PG_NPM_VERSION (@embedded-postgres/darwin-arm64)"
if [ ! -x "$DEST/pg/bin/postgres" ]; then
  npm pack "@embedded-postgres/darwin-arm64@$PG_NPM_VERSION" --pack-destination "$WORK" >/dev/null
  tar -xzf "$WORK"/embedded-postgres-darwin-arm64-*.tgz -C "$WORK"
  rm -rf "$DEST/pg"
  mv "$WORK/package/native" "$DEST/pg"
  chmod +x "$DEST"/pg/bin/*
  # npm tarballs cannot carry symlinks, so the package ships a manifest of the
  # dylib version-name links (libzstd.1.dylib -> libzstd.1.5.7.dylib, ...) and
  # hydrates them post-install. Replicate that here or postgres won't load.
  python3 - "$DEST/pg" <<'PY'
import json, os, sys
root = sys.argv[1]
with open(os.path.join(root, "pg-symlinks.json")) as f:
    for link in json.load(f):
        src = link["source"].removeprefix("native/")
        dst = os.path.join(root, link["target"].removeprefix("native/"))
        rel = os.path.relpath(os.path.join(root, src), os.path.dirname(dst))
        if not os.path.lexists(dst):
            os.symlink(rel, dst)
PY
  # The extensions the schema needs must be in the build — fail loudly here,
  # not at first-run initdb on a user's machine.
  test -f "$DEST/pg/share/postgresql/extension/pgcrypto.control"
  test -f "$DEST/pg/share/postgresql/extension/pg_trgm.control"
else
  echo "    already present, skipping"
fi

echo "==> PostgREST $POSTGREST_VERSION"
if [ ! -x "$DEST/postgrest" ]; then
  curl -fsSL -o "$WORK/postgrest.tar.xz" \
    "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-macos-aarch64.tar.xz"
  tar -xJf "$WORK/postgrest.tar.xz" -C "$WORK"
  mv "$WORK/postgrest" "$DEST/postgrest"
  chmod +x "$DEST/postgrest"
else
  echo "    already present, skipping"
fi

echo "==> GoTrue (supabase/auth) $GOTRUE_VERSION"
# No usable official macOS binary: the release asset NAMED darwin-arm64
# actually contains Linux ELF binaries (verified against v2.189.0 — both
# files in the tarball are ELF aarch64). GoTrue is pure Go with CGO off, so
# building the pinned tag from source is deterministic and takes ~2 minutes.
# The migrations directory from the same tag ships next to the binary —
# GoTrue applies them itself at boot and refuses to start without them.
if [ ! -x "$DEST/gotrue" ] || ! file "$DEST/gotrue" | grep -q Mach-O; then
  command -v go >/dev/null || { echo "Go toolchain required (brew install go)"; exit 1; }
  git clone --depth 1 --branch "$GOTRUE_VERSION" \
    https://github.com/supabase/auth "$WORK/auth" 2>/dev/null
  (cd "$WORK/auth" && CGO_ENABLED=0 go build -o "$WORK/gotrue-bin" .)
  rm -f "$DEST/gotrue"; rm -rf "$DEST/gotrue-migrations"
  mv "$WORK/gotrue-bin" "$DEST/gotrue"
  mv "$WORK/auth/migrations" "$DEST/gotrue-migrations"
  chmod +x "$DEST/gotrue"
  file "$DEST/gotrue" | grep -q Mach-O
else
  echo "    already present, skipping"
fi

echo "==> Done:"
"$DEST/pg/bin/postgres" --version
"$DEST/postgrest" --version | head -1
echo "gotrue $GOTRUE_VERSION ($("$DEST/gotrue" version 2>/dev/null || echo binary present))"
