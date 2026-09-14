#!/usr/bin/env bash
# Build the product halves the local stack runs:
#   backend  → backend/dist          (tsc; runs under Electron's Node)
#   frontend → frontend/.next/standalone  (Next standalone server with the
#              local-stack URLs baked in — see desktop/src/local/config.js)
#
# Dev-mode local runs use these outputs in place; packaging stages them into
# local-stack/app/ (see stage-local-stack.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Must match desktop/src/local/config.js exactly: the frontend bundle bakes
# these origins, and the supervisor's fixed ports have to be where the bundle
# points. The anon key is the well-known Supabase demo placeholder that the
# local gateway swaps for the per-install key at request time.
GATEWAY_URL="http://localhost:42813"
BACKEND_URL="http://localhost:42814"
PLACEHOLDER_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

echo "==> backend (tsc)"
(cd backend && npx tsc)

echo "==> frontend (next build, standalone, local URLs baked)"
(cd frontend && rm -rf .next && \
  NEXT_OUTPUT_STANDALONE=1 \
  NEXT_PUBLIC_SUPABASE_URL="$GATEWAY_URL" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY="$PLACEHOLDER_ANON_KEY" \
  NEXT_PUBLIC_API_BASE_URL="$BACKEND_URL" \
  npm run build)

# Standalone output does not include static assets or public/ — the server
# expects them beside it (Next's documented deployment step).
echo "==> staging static assets into the standalone server"
rm -rf frontend/.next/standalone/.next/static frontend/.next/standalone/public
cp -R frontend/.next/static frontend/.next/standalone/.next/static
[ -d frontend/public ] && cp -R frontend/public frontend/.next/standalone/public

echo "==> done"
