# Build from the repository root; shared wire declarations live in packages/contracts.
FROM node:22-slim

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /packages/contracts
COPY word-addin/src /word-addin/src

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
