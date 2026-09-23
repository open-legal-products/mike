#!/usr/bin/env bash
# Build the product halves the local stack runs:
#   backend  → backend/dist          (tsc; runs under Electron's Node)
#   frontend → frontend/.next/standalone  (Next standalone server with the
#              same-origin API gateway configured by the local supervisor)
#
# Dev-mode local runs use these outputs in place; packaging stages them into
# local-stack/app/ (see stage-local-stack.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "==> backend (tsc)"
(cd backend && npx tsc)

echo "==> bundled workflow catalog (downloaded at build, installed offline)"
node desktop/scripts/bundle-workflows.js

echo "==> frontend (next build, standalone, local reporting disabled)"
(cd frontend && rm -rf .next && \
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  NEXT_OUTPUT_STANDALONE=1 \
  SENTRY_DISABLED=true NEXT_PUBLIC_SENTRY_DISABLED=true \
  SENTRY_AUTH_TOKEN= SENTRY_ORG= SENTRY_PROJECT= \
  NEXT_TELEMETRY_DISABLED=1 \
  NODE_OPTIONS=--max-old-space-size=3072 \
  npm run build -- --webpack)

# Standalone output does not include static assets or public/ — the server
# expects them beside it (Next's documented deployment step).
echo "==> staging static assets into the standalone server"
rm -rf frontend/.next/standalone/.next/static frontend/.next/standalone/public
cp -R frontend/.next/static frontend/.next/standalone/.next/static
[ -d frontend/public ] && cp -R frontend/public frontend/.next/standalone/public
# Next may trace a developer's local env file into standalone output. The
# downloaded app receives its complete configuration from the supervisor.
for file in frontend/.next/standalone/.env frontend/.next/standalone/.env.*; do
  [ ! -f "$file" ] || rm "$file"
done

echo "==> done"
