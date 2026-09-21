# ponytail: single stage. LibreOffice dwarfs everything, multi-stage saves little.
FROM node:22-slim

# Pinned uv supplies the managed Python and package runtime for the USPTO
# connector (see docs/patent-mcp-connector.md).
COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /usr/local/bin/

# libreoffice-convert shells out to soffice for doc conversion (see src/lib/convert.ts)
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice \
  && rm -rf /var/lib/apt/lists/*

# Preinstall the pinned USPTO connector runtime at build time so the first
# user request never downloads packages. The backend launches the bare
# preinstalled entrypoint (PATENT_MCP_EXECUTABLE); PATENT_MCP_UV_DATA_DIR
# keeps uv's caches on writable container storage. The feature itself stays
# default-off per user until turned on in Settings > Features.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install --python 3.13 \
      --with 'mcp[cli]>=1.27,<2' \
      patent-mcp-server==1.0.0
ENV PATENT_MCP_EXECUTABLE=patent-mcp-server \
    PATENT_MCP_UV_DATA_DIR=/app/data/uv

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY packages/contracts /packages/contracts
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "start"]
