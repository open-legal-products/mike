# ponytail: single stage. LibreOffice dwarfs everything, multi-stage saves little.
FROM node:22-slim

# libreoffice-convert shells out to soffice for doc conversion (see src/lib/convert.ts)
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci

# Headless Chromium renders visuals to PNG/PDF and the Python wheels power
# code analysis; both run in the `sandbox` service built from this same image
# (docs/code-analysis.md). Fetched before the source so they cache separately.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*
COPY backend/scripts/fetch-pyodide-packages.mjs scripts/
RUN node scripts/fetch-pyodide-packages.mjs
RUN useradd --system --no-create-home mikesandbox \
  && mkdir -p /run/mike-sandbox && chown mikesandbox /run/mike-sandbox

COPY backend/ ./
COPY packages/contracts /packages/contracts
RUN npm run build

# --enable-source-maps: every entrypoint in this image (API, worker,
# sync:workflows) reports stack frames as src/*.ts lines, not dist/*.js.
# The commit this image was built from; Sentry's release tag when
# SENTRY_RELEASE is not set (docs/observability.md).
ARG GIT_SHA=
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps GIT_SHA=$GIT_SHA
EXPOSE 3001
CMD ["npm", "start"]
