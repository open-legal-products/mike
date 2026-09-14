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
test -f frontend/.next/standalone/server.js || { echo "run local:build first"; exit 1; }

APP="desktop/local-stack/app"
rm -rf "$APP"
mkdir -p "$APP/backend" "$APP/frontend"

echo "==> backend (dist + prod deps + schema/migrations)"
cp -R backend/dist "$APP/backend/dist"
cp backend/package.json backend/package-lock.json backend/schema.sql "$APP/backend/"
cp -R backend/migrations "$APP/backend/migrations"
(cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

echo "==> frontend (standalone server)"
cp -R frontend/.next/standalone/. "$APP/frontend/"

echo "==> staged into $APP"
