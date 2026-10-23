# Build from the repository root: `docker build -f frontend/Dockerfile .`
# (docker-compose.yml does the same). The image needs the frontend plus the
# one sibling directory production code reaches through a tsconfig `paths`
# alias: `@mike/contracts` -> /packages/contracts. Nothing else. `next build`
# type-checks tsconfig.build.json, which leaves test files -- and their
# imports of shared fixtures and add-in sources -- out of the image.
#
# A new outside dependency needs a COPY here and a tsconfig alias that
# resolves to the same path; frontend/src/__tests__/architecture.test.ts
# checks that the two agree, and .github/workflows/docker-images.yml builds
# this file in CI so a miss fails the pull request, not the next fresh install.
FROM node:22-slim

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /packages/contracts

# Browser-side Sentry DSN (optional). Inlined by next build, so it must be
# present here rather than at container start. See docs/observability.md.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_DISABLED=
ARG NEXT_PUBLIC_SENTRY_INSTALL=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
# Product name and link-preview copy (src/shared/lib/branding.ts); empty keeps
# Mike's. Inlined by next build like the Sentry values.
ARG NEXT_PUBLIC_APP_NAME=
ARG NEXT_PUBLIC_APP_TAGLINE=
ARG NEXT_PUBLIC_APP_HOME_URL=
ARG NEXT_PUBLIC_APP_URL=
ARG NEXT_PUBLIC_APP_DESCRIPTION=
ARG NEXT_PUBLIC_APP_DOMAIN=
# The commit this image was built from; the release tag when no explicit
# release is given, for the browser bundle (inlined) and the Next server.
ARG GIT_SHA=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_DISABLED=$NEXT_PUBLIC_SENTRY_DISABLED \
    NEXT_PUBLIC_SENTRY_INSTALL=$NEXT_PUBLIC_SENTRY_INSTALL \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    NEXT_PUBLIC_GIT_SHA=$GIT_SHA \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_APP_TAGLINE=$NEXT_PUBLIC_APP_TAGLINE \
    NEXT_PUBLIC_APP_HOME_URL=$NEXT_PUBLIC_APP_HOME_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APP_DESCRIPTION=$NEXT_PUBLIC_APP_DESCRIPTION \
    NEXT_PUBLIC_APP_DOMAIN=$NEXT_PUBLIC_APP_DOMAIN \
    GIT_SHA=$GIT_SHA

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
