# Build context is the REPO ROOT (see docker-compose.yml): the frontend
# type-imports from backend/src (e.g. shared/types.ts pulls AskInputsEvent
# from backend/src/lib/chat/types), and its parity tests import word-addin/src.
# A frontend-only context makes those imports fail during `next build`. Only
# the required sibling sources are copied; they are not runtime dependencies.
FROM node:22-slim

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/src /backend/src
COPY word-addin/src /word-addin/src

# Browser-side Sentry DSN (optional). Inlined by next build, so it must be
# present here rather than at container start. See docs/observability.md.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
