# Build from the repository root: `docker build -f frontend/Dockerfile .`
# (docker-compose.yml does the same). The image mirrors the repository layout
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
FROM node:22-slim

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /app/packages/contracts
COPY packages/ui /app/packages/ui
COPY packages/client /app/packages/client

# Browser-side Sentry DSN (optional). Inlined by next build, so it must be
# present here rather than at container start. See docs/observability.md.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_DISABLED=
ARG NEXT_PUBLIC_SENTRY_INSTALL=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
# The commit this image was built from; the release tag when no explicit
# release is given, for the browser bundle (inlined) and the Next server.
ARG GIT_SHA=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_DISABLED=$NEXT_PUBLIC_SENTRY_DISABLED \
    NEXT_PUBLIC_SENTRY_INSTALL=$NEXT_PUBLIC_SENTRY_INSTALL \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    NEXT_PUBLIC_GIT_SHA=$GIT_SHA \
    GIT_SHA=$GIT_SHA

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
