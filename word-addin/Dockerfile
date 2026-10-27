# Build from the repository root: `docker build -f word-addin/Dockerfile .`
# The add-in bundles the packages it shares with the web app (packages/ui and
# packages/client, reached through webpack aliases, tsconfig paths, and a
# Tailwind @source entry), the web app's icons (frontend/public/icons, the
# @icons alias), and the @mike/contracts declarations. Nothing else outside
# word-addin/ is read.
# .github/workflows/docker-images.yml builds this file in CI so a new outside
# dependency fails the pull request, not the next deploy.
FROM node:22-slim AS build

WORKDIR /app
COPY word-addin/package*.json ./
RUN npm ci
COPY word-addin/ ./
COPY frontend/public/icons /frontend/public/icons
COPY packages/contracts /packages/contracts
COPY packages/ui /packages/ui
COPY packages/client /packages/client

ARG REACT_APP_WEB_APP_URL
ARG WORD_ADDIN_PUBLIC_URL
# Optional Sentry DSN, baked into the static bundle (docs/observability.md).
ARG REACT_APP_SENTRY_DSN=
ARG REACT_APP_SENTRY_DISABLED=
ARG REACT_APP_SENTRY_INSTALL=
ARG REACT_APP_SENTRY_ENVIRONMENT=
ARG REACT_APP_SENTRY_RELEASE=
# The commit this image was built from; the release tag when none is given.
ARG GIT_SHA=
ENV REACT_APP_API_BASE_URL=/api \
    REACT_APP_GIT_SHA=$GIT_SHA \
    REACT_APP_WEB_APP_URL=$REACT_APP_WEB_APP_URL \
    WORD_ADDIN_PUBLIC_URL=$WORD_ADDIN_PUBLIC_URL \
    REACT_APP_SENTRY_DSN=$REACT_APP_SENTRY_DSN \
    REACT_APP_SENTRY_DISABLED=$REACT_APP_SENTRY_DISABLED \
    REACT_APP_SENTRY_INSTALL=$REACT_APP_SENTRY_INSTALL \
    REACT_APP_SENTRY_ENVIRONMENT=$REACT_APP_SENTRY_ENVIRONMENT \
    REACT_APP_SENTRY_RELEASE=$REACT_APP_SENTRY_RELEASE
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY word-addin/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=3200
EXPOSE 3200
CMD ["node", "server.mjs"]
