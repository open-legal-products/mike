# syntax=docker/dockerfile:1
# Build from the repository root: `docker build -f word-addin/Dockerfile .`
# The add-in bundles the UI it shares with the web app (frontend/src/shared,
# reached through webpack aliases, tsconfig paths, and Tailwind @source
# entries), the web app's icons (frontend/public/icons, the @icons alias), and
# the @mike/contracts declarations. Nothing else outside word-addin/ is read.
# .github/workflows/docker-images.yml builds this file in CI so a new outside
# dependency fails the pull request, not the next deploy.
FROM node:22-slim AS build

WORKDIR /app
COPY word-addin/package*.json ./
RUN npm ci
COPY word-addin/ ./
COPY frontend/src/shared /frontend/src/shared
COPY frontend/public/icons /frontend/public/icons
COPY packages/contracts /packages/contracts

ARG REACT_APP_WEB_APP_URL
ARG WORD_ADDIN_PUBLIC_URL
# Optional Sentry DSN, baked into the static bundle (docs/observability.md).
ARG REACT_APP_SENTRY_DSN=
ARG REACT_APP_SENTRY_DISABLED=
ARG REACT_APP_SENTRY_INSTALL=
ARG REACT_APP_SENTRY_ENVIRONMENT=
ARG REACT_APP_SENTRY_RELEASE=
# Release identity (docs/observability.md): mike@<version>+<sha12>.
ARG MIKE_VERSION=
ARG GIT_SHA=
ENV REACT_APP_API_BASE_URL=/api \
    REACT_APP_MIKE_VERSION=$MIKE_VERSION \
    REACT_APP_GIT_SHA=$GIT_SHA \
    REACT_APP_WEB_APP_URL=$REACT_APP_WEB_APP_URL \
    WORD_ADDIN_PUBLIC_URL=$WORD_ADDIN_PUBLIC_URL \
    REACT_APP_SENTRY_DSN=$REACT_APP_SENTRY_DSN \
    REACT_APP_SENTRY_DISABLED=$REACT_APP_SENTRY_DISABLED \
    REACT_APP_SENTRY_INSTALL=$REACT_APP_SENTRY_INSTALL \
    REACT_APP_SENTRY_ENVIRONMENT=$REACT_APP_SENTRY_ENVIRONMENT \
    REACT_APP_SENTRY_RELEASE=$REACT_APP_SENTRY_RELEASE
# Sentry source-map upload, as in frontend/Dockerfile.
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
    npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY word-addin/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
