# ponytail: single stage. LibreOffice dwarfs everything, multi-stage saves little.
FROM node:22-slim

# libreoffice-convert shells out to soffice for doc conversion (see src/lib/convert.ts).
# postgresql-client: docker-compose.yml runs db-init from this image so the
# schema and migrations applied always belong to the same release as the code
# (scripts/migrate.sh needs psql).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice util-linux postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY packages/contracts /packages/contracts
# The compose db-init step (schema.sql, migrations/, scripts/migrate.sh are
# already here) also needs the ledger-adoption script for pre-ledger volumes.
COPY docker/db-init/adopt-ledger.sh ./docker/db-init/adopt-ledger.sh
RUN npm run build

# --enable-source-maps: every entrypoint in this image (API, worker,
# sync:workflows) reports stack frames as src/*.ts lines, not dist/*.js.
# Release identity: the product version and the commit this image was built
# from (docs/observability.md); Sentry tags events mike@<version>+<sha12>
# unless SENTRY_RELEASE is set. A build without them is mike@0.0.0.
ARG MIKE_VERSION=
ARG GIT_SHA=
# Reporting defaults a fork's published image can bake in (both stay
# overridable at runtime): SENTRY_DISABLED=true for a fork without its own
# Sentry, or the fork's own backend DSN. Keep these separate from runtime
# variables so empty Compose env_file values cannot erase the baked defaults.
ARG SENTRY_DISABLED=
ARG SENTRY_DSN=
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps \
    MIKE_VERSION=$MIKE_VERSION GIT_SHA=$GIT_SHA \
    MIKE_BUILD_SENTRY_DISABLED=$SENTRY_DISABLED MIKE_BUILD_SENTRY_DSN=$SENTRY_DSN
EXPOSE 3001
CMD ["npm", "start"]
