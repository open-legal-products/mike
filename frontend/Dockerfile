# syntax=docker/dockerfile:1
# Build from the repository root: `docker build -f frontend/Dockerfile .`
# (docker-compose.yml does the same). The build mirrors the repository layout
# under /app: the frontend at /app/frontend plus the sibling directories
# production code reaches through tsconfig `paths` aliases, `@mike/contracts`
# -> /app/packages/contracts, `@mike/ui` -> /app/packages/ui and
# `@mike/client` -> /app/packages/client. Nothing else. The layout matters:
# next.config.ts sets the Turbopack root to the frontend's parent directory,
# which must contain the packages. `next build` type-checks
# tsconfig.build.json, which leaves test files -- and their imports of shared
# fixtures and add-in sources -- out of the image.
#
# A new outside dependency needs a COPY here and a tsconfig alias that
# resolves to the same path; frontend/src/__tests__/architecture.test.ts
# checks that the two agree, and .github/workflows/docker-images.yml builds
# this file in CI so a miss fails the pull request, not the next fresh install.
# The publish workflow can rebuild `app` (where the Sentry
# source-map upload happens inside `next build`) without redoing `npm ci`:
# BuildKit would otherwise reuse the build layer from a token-less build and
# silently skip the upload, because secret contents are not part of the cache
# key (.github/workflows/publish-images.yml, no-cache-filters).
FROM node:22-slim AS deps

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

FROM node:22-slim AS configured
WORKDIR /app/frontend
# Baked Sentry defaults for the Next server and browser tunnel (optional).
# Non-empty runtime SENTRY_* values override them. See docs/observability.md.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_DISABLED=
ARG NEXT_PUBLIC_SENTRY_INSTALL=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
# Release identity: the product version (VERSION, or VERSION-dev.<run> for a
# main build) and the commit, both from the publish workflow. Together they
# make the release `mike@<version>+<sha12>` for the browser bundle (inlined)
# and the Next server; a local build without them is `mike@0.0.0...`.
ARG MIKE_VERSION=
ARG GIT_SHA=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_DISABLED=$NEXT_PUBLIC_SENTRY_DISABLED \
    NEXT_PUBLIC_SENTRY_INSTALL=$NEXT_PUBLIC_SENTRY_INSTALL \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    NEXT_PUBLIC_MIKE_VERSION=$MIKE_VERSION \
    NEXT_PUBLIC_GIT_SHA=$GIT_SHA \
    MIKE_VERSION=$MIKE_VERSION \
    GIT_SHA=$GIT_SHA

FROM configured AS app
COPY --from=deps /app/frontend/node_modules ./node_modules
COPY frontend/ ./
COPY packages/contracts /app/packages/contracts
COPY packages/ui /app/packages/ui
COPY packages/client /app/packages/client

# Sentry source-map upload (docs/observability.md). Needs all three; the token
# is a build secret so it never lands in an image layer.
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
# A non-secret switch participates in the cache key: enabling uploads must
# rebuild a previously tokenless bundle. Token rotation/re-upload also needs
# --no-cache because BuildKit deliberately excludes secret contents.
ARG SENTRY_UPLOAD_ENABLED=0
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN \
    case "$SENTRY_UPLOAD_ENABLED" in \
      0) unset SENTRY_AUTH_TOKEN ;; \
      1) if [ -z "$SENTRY_AUTH_TOKEN" ] || [ -z "$SENTRY_ORG" ] || [ -z "$SENTRY_PROJECT" ]; then \
           echo "Sentry upload requires the token build secret, SENTRY_ORG and SENTRY_PROJECT" >&2; exit 1; \
         fi ;; \
      *) echo "SENTRY_UPLOAD_ENABLED must be 0 or 1" >&2; exit 1 ;; \
    esac; \
    NEXT_OUTPUT_STANDALONE=1 npm run build

# The tracing root is /app, so the generated server lives under frontend/.
# Next serves public assets and client chunks alongside that server.
FROM configured AS runtime
COPY --from=app /app/frontend/.next/standalone /app
COPY --from=app /app/frontend/.next/static ./.next/static
COPY --from=app /app/frontend/public ./public
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
