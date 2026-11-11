#!/usr/bin/env bash
# Stage the built product into local-stack/app/ for packaging. After this,
# `npm run dist:local` produces a Mike.app that carries the whole stack
# (config.js resolves these paths under process.resourcesPath when packaged).
#
# Prereqs: scripts/fetch-local-stack.sh (binaries) and
# scripts/build-local-stack.sh (backend dist + frontend standalone) have run.
set -euo pipefail
cd "$(dirname "$0")/../.."

test -x desktop/local-stack/bin/pg/bin/postgres || { echo "run local:fetch first"; exit 1; }
test -f backend/dist/index.js || { echo "run local:build first"; exit 1; }
test -f backend/dist/workflow-catalog/catalog.json || { echo "run local:build to bundle offline workflows"; exit 1; }
test -f frontend/.next/standalone/frontend/server.js || { echo "run local:build first"; exit 1; }

# Also cover cached fetch output when staging directly. This must precede
# electron-builder signing; rewriting a signed release invalidates its seal.
node desktop/scripts/relocate-postgrest.mjs desktop/local-stack/bin

APP="desktop/local-stack/app"
rm -rf "$APP"
mkdir -p "$APP/backend" "$APP/frontend"
node desktop/scripts/stage-source-notices.mjs "$APP" desktop/local-stack/bin/notices

echo "==> backend (dist + prod deps + schema/migrations)"
cp -R backend/dist "$APP/backend/dist"
cp backend/package.json backend/package-lock.json backend/schema.sql "$APP/backend/"
# The supervisor checks Electron's Node against the backend's engines floor
# with the backend's own script before it spawns the backend.
mkdir -p "$APP/backend/scripts"
cp backend/scripts/check-node-version.cjs "$APP/backend/scripts/"
cp -R backend/migrations "$APP/backend/migrations"
(cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

# The standalone output is traced from the repository root, so it holds
# frontend/server.js next to the node_modules it needs (see
# desktop/src/local/config.js).
echo "==> frontend (standalone server)"
cp -R frontend/.next/standalone/. "$APP/frontend/"

echo "==> staged into $APP"
