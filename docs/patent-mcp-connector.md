# USPTO Patent & Trademark connector

This guide covers building and deploying the managed USPTO Patent & Trademark
connector.

## What the connector is

The connector runs the upstream [`riemannzeta/patent_mcp_server`](https://github.com/riemannzeta/patent_mcp_server)
server locally as an unmodified dependency. The backend launches it over MCP
stdio and exposes its tools to assistant conversations. The connector is
managed: the server, the runtime, and the launch command are fixed by the
deployment, not by the browser.

The feature switch (**Settings > Features > USPTO Patent & Trademark**) is off
by default for new and existing users. When the feature switch is off, the
backend blocks provisioning, tool refresh, model tool exposure, and tool
execution.

The upstream dependency is pinned exactly:

| Pin | Value |
| --- | --- |
| Upstream server | `riemannzeta/patent_mcp_server`, unmodified |
| Package | `patent-mcp-server==1.0.0` from PyPI (uploaded 2026-06-10) |
| Upstream commit | `67ff3136491a52637ef97dd0093b10542f488097` (post-1.0.0, uv.lock-only changes) |
| Python | `3.13` (the package declares `requires-python >=3.10, <3.14`) |
| MCP SDK | `mcp[cli]>=1.27,<2` (matches the upstream lockfile at that commit; excludes MCP SDK 2.x, which the server does not support) |
| uv | `0.12.17` (the backend image copies the binary from `ghcr.io/astral-sh/uv:0.12.17`) |
| Connector identity | `builtin://patent-mcp-server` |

The connector row stores the runtime pins in `tool_policy`. The database check
constraint allows the `stdio` transport only for this identity with
`auth_type = 'none'`. A partial unique index,
`user_mcp_connectors_managed_patent_uidx`, gives one managed connector per
user. Concurrent provisioning collapses onto one row.

The upstream server is MIT licensed. Mike uses the unmodified package via
PyPI, which preserves its license notice.

## Prerequisites

- Node.js 22 or newer, npm, and Git.
- A Supabase project and environment files as described in the
  [README](../README.md) quick start and
  [Manual and production deployment](deployment.md). This guide does not
  re-document the application setup.
- Docker path: nothing else on the host. The backend image contains the pinned
  runtime.
- Native path: `uv` and `uvx` on the PATH of the operating-system user that
  runs the backend. Install the pinned release:

  ```bash
  curl -LsSf https://astral.sh/uv/0.12.17/install.sh | sh
  ```

  Or download the pinned binary for your platform from release `0.12.17` on
  the [uv releases page](https://github.com/astral-sh/uv/releases/tag/0.12.17)
  and place `uv` and `uvx` on the PATH.

Confirm both commands are visible to the backend user:

```bash
uv --version
uvx --version
```

## Native development

Run the full sequence from a fresh clone.

1. Clone the repository:

   ```bash
   git clone https://github.com/open-legal-products/mike
   cd mike
   ```

2. Install dependencies:

   ```bash
   npm install --prefix backend
   npm install --prefix frontend
   ```

3. Set up the backend environment:

   ```bash
   cp backend/.env.example backend/.env
   ```

4. Add a model-provider key and the required secrets to `backend/.env` as the
   [README](../README.md) describes.

5. Build both packages:

   ```bash
   npm run build --prefix backend
   npm run build --prefix frontend
   ```

6. Start each package in a separate terminal:

   ```bash
   npm run dev --prefix backend
   ```

   ```bash
   npm run dev --prefix frontend
   ```

7. Warm up the runtime once as the backend user:

   ```bash
   uvx --python 3.13 --from patent-mcp-server==1.0.0 --with 'mcp[cli]>=1.27,<2' patent-mcp-server
   ```

   A successful launch prints the server configuration and
   `Starting USPTO Patent MCP server with stdio transport`, then waits for MCP
   messages on stdio. Stop it with Ctrl+C. The first run downloads a managed
   Python (about 33 MB) and the package into the uv cache. Later launches use
   the cache and start in seconds.

### Optional: run from a local upstream checkout

`PATENT_MCP_DIRECTORY` runs an unmodified upstream checkout instead of the
pinned package. It is for native development only. Do not set it in Docker.

```bash
git clone https://github.com/riemannzeta/patent_mcp_server.git
```

Set the absolute path in `backend/.env`:

```dotenv
PATENT_MCP_DIRECTORY=/absolute/path/to/patent_mcp_server
```

Mike then runs:

```bash
uv --directory "$PATENT_MCP_DIRECTORY" run --python 3.13 --with 'mcp[cli]>=1.27,<2' patent-mcp-server
```

## Docker Compose

The backend image already contains the pinned uv binary, Python 3.13, and the
pinned server package. The image preinstalls the runtime at build time, so the
first user request never downloads packages.

From a fresh checkout, build and start the stack:

```bash
docker compose build backend
docker compose up -d
```

No host Python or `uv` is required. The image keeps the classic single-stage
Dockerfile pattern and adds no new host prerequisites.

## Database migration

Fresh installs apply `backend/schema.sql`, which already contains the new
shape. The Compose `db-init` service replays every migration file by name,
including `20260920_01_uspto_patent_trademark_connector.sql`, for existing
Compose volumes.

Existing deployments apply only the new migration file. It adds the profile
column, widens the transport check, and adds the unique index.

1. Back up the database first:

   ```bash
   pg_dump "$DATABASE_URL" > backup-before-uspto-connector.sql
   ```

2. Apply the migration:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/20260920_01_uspto_patent_trademark_connector.sql
   ```

Rollback limitation: remove or convert any `stdio` connector rows before
restoring the old transport check.

## Configuration

All variables are optional and go in `backend/.env`. Restart the backend after
changes.

### Optional upstream credentials

| Variable | Purpose | Where to obtain |
| --- | --- | --- |
| `USPTO_API_KEY` | Open Data Portal and PTAB tools | Register at [data.uspto.gov](https://data.uspto.gov), then create a key under "My ODP" |
| `TSDR_API_KEY` | TSDR trademark status and document tools | USPTO TSDR API registration. Distinct from `USPTO_API_KEY` |
| `TMSEARCH_WAF_TOKEN` | Trademark-search AWS WAF token | Browser renewal per [Renewing the USPTO trademark-search WAF token](tmsearch-waf-token.md) |

The WAF token is temporary and can require manual renewal. Use placeholder
values only in examples. Never put a real key in documentation or source
control.

```dotenv
USPTO_API_KEY=replace-with-your-uspto-odp-key
TSDR_API_KEY=replace-with-your-tsdr-key
TMSEARCH_WAF_TOKEN=replace-with-your-waf-token
```

### Per-user credentials in the web UI

A user can also enter all three credentials in the web UI. Open
**Settings > Connectors**, select the **USPTO Patent & Trademark** connector,
and fill the credential fields. The placeholders name the environment
variables: `USPTO_API_KEY`, `TSDR_API_KEY`, and `TMSEARCH_WAF_TOKEN`. Select
**Save**.

- The backend stores the values encrypted in the connector's auth config.
- The API returns only whether each value is saved. It never returns the
  value.
- A saved value overrides the deployment environment variable.
- Clear a field and save to remove the saved value and fall back to the
  environment variable.

When no user saves a credential, the deployment environment variable applies.
All users then share the upstream quota. This is the default shared model.

### Runtime variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PATENT_MCP_EXECUTABLE` | unset | Bare entrypoint name to run instead of `uvx`. Docker images preinstall the tool and set this at build time. |
| `PATENT_MCP_DIRECTORY` | unset | Native development only. Runs an unmodified upstream checkout. |
| `PATENT_MCP_UV_DATA_DIR` | `backend/data/uv` (`<backend working dir>/data/uv`) | Location for uv caches, tool environments, and managed Python installs. |
| `PATENT_MCP_MAX_CONCURRENT` | `4` | Maximum connector child processes per backend instance. |
| `PATENT_MCP_MAX_QUEUE` | `32` | Maximum callers that wait for a process slot. |
| `PATENT_MCP_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for a process slot in milliseconds. |

### Process-environment rules

The browser never supplies an executable, a path, or a package. The server
selects the command:

1. `PATENT_MCP_EXECUTABLE` (bare entrypoint name; Docker images preinstall the
   tool at build time).
2. `PATENT_MCP_DIRECTORY` (native development only; runs an unmodified
   upstream checkout).
3. Default:

   ```bash
   uvx --python 3.13 --from patent-mcp-server==1.0.0 --with 'mcp[cli]>=1.27,<2' patent-mcp-server
   ```

Only these variables pass into the child process: `USPTO_API_KEY`,
`TSDR_API_KEY`, `TMSEARCH_WAF_TOKEN`, `LOG_LEVEL`, `REQUEST_TIMEOUT`,
`MAX_RETRIES`, `RETRY_MIN_WAIT`, `RETRY_MAX_WAIT`, `SESSION_EXPIRY_MINUTES`,
and `ENABLE_CACHING`. Mike database credentials, LLM keys, and encryption
secrets never pass through.

Credentials come from two sources. A per-user value saved in Settings >
Connectors wins. Otherwise the deployment environment variable applies, and
users of that deployment share the upstream credential quota. Credential
values are encrypted at rest and never appear in API responses.

The connector starts one short-lived child process per MCP operation and
closes it on success, error, timeout, or cancellation. The connect timeout is
180 s. Single requests time out at 30 s. The exact-owner trademark search gets
10 min because it reuses one session for the whole batch.

## Activation and smoke test

1. Sign in and turn on **Settings > Features > USPTO Patent & Trademark**.
2. Open **Settings > Connectors** and select the **USPTO** button.
3. Wait for provisioning. Success looks like a **USPTO Patent & Trademark**
   connector with its tool count listed.
4. Open the connector details to review the tool catalog. Disable any tools
   you do not want exposed to conversations.
5. Run a patent smoke test in the Assistant, for example:
   "Search patents for US patent 10,000,000 and summarize it."
6. Run a trademark smoke test: pass the complete legal owner name through the
   `owner_name` argument, for example
   `Search trademarks owned by "Example Owner, LLC" with owner_name`.

Tools marked destructive or non-read-only by the server stay disabled under
the existing confirmation policy. The connector can be disabled and
re-enabled. The connector row and tool choices persist across off/on
transitions of the feature switch. Managed connectors cannot be deleted or
repointed. Disable the connector instead. Rename and enable/disable are
allowed. Changes to the endpoint, bearer token, custom headers, and OAuth are
blocked.

### Supported tools: exact-owner trademark search

Calling `tm_search_trademarks` with `owner_name` returns only marks whose
current owner name matches after normalization. Normalization applies NFKC,
maps `&` to `AND`, collapses punctuation and whitespace, and folds case.
Entity suffixes stay distinct, so `LLC` does not match `INC`.

Pass up to 10 owners per call through `owner_names`. Owners are searched
serially with 2.5 s spacing. Candidate pages contain 10 records with 1 s
spacing. The search stops at 1,000 candidates with an explicit incomplete
warning. HTTP 429 retries after 10 s, 20 s, and 30 s. On continued throttling,
the response lists `failed_owner_names` with a 60 s cooldown guidance. Results
are compact portfolio records capped to stay valid JSON under Mike's 60,000
character limit.

The upstream README marks some of its 61 tools unavailable because USPTO shut
down services (PatentsView, Office Action, Enriched Citation). A listed tool
is not a guaranteed-working USPTO API. Report upstream outages separately from
connector failures.

Tools that download patents as PDF return a file path on the backend host. A
container path is not a usable browser download. These tools remain exposed,
but their output paths are useful only to operators with host access. A
download adapter is planned follow-up work.

When the feature switch is off, tool execution returns
`{ ok: false, error: "The USPTO Patent & Trademark feature is off. Turn it on in Settings > Features." }`.
Provisioning maps to HTTP 403 with `code: "feature_disabled"`. A missing
runtime maps to HTTP 409 with `code: "runtime_unavailable"`. Other failures
map to HTTP 400.

## Updates and rebuilds

The connector identity `builtin://patent-mcp-server` is version-agnostic, so
existing connectors keep working across a pin change.

To bump the pin:

1. Edit the three constants `PATENT_MCP_PACKAGE`, `PATENT_MCP_PYTHON`, and
   `PATENT_MCP_SDK` in `backend/src/lib/mcp/patentServer.ts`.
2. Update the `uv tool install` line in `backend/Dockerfile`.
3. The Compose stack builds from `backend/Dockerfile` and holds no separate
   pins. Rebuild the image:

   ```bash
   docker compose build backend
   ```

4. Restart the stack. Select **USPTO** again to refresh the tool catalog.
   Prior enabled and disabled tool choices persist.

## Troubleshooting

### `spawn uvx ENOENT`

`uv` is not on the PATH of the backend user. Install the pinned release and
restart the backend.

### `runtime_unavailable` (HTTP 409)

The runtime is missing on the server. Install `uv` and `uvx` for native
deployments, or rebuild the backend image for Docker deployments.

### First launch is slow on native installs

uv downloads the managed Python and the package on the first launch. Run the
warm-up command from the native development section once, then retry.

### TMSEARCH WAF failures

Trademark searches fail with an AWS WAF, HTTP 202, HTTP 403, or
`WAF_CHALLENGE` error. Follow
[Renewing the USPTO trademark-search WAF token](tmsearch-waf-token.md).

### HTTP 429 rate limiting

HTTP 429 is a request-rate limit, not a WAF failure. Do not renew the token.
Mike retries and paces requests. On continued throttling, wait at least 60 s
and retry only the failed owners.

### Timeouts

The connect timeout is 180 s. Single requests time out at 30 s. The
exact-owner trademark search has its own 10 min bound.

### USPTO API outages

An imported tool can be present even when USPTO has shut down its service.
Check the upstream README. Report upstream outages separately from connector
failures.

### Tool counts

Do not use a fixed tool count as the sole success criterion. Compare
representative tool results instead.

## Testing

Run the targeted backend tests:

```bash
npm test --prefix backend -- src/lib/mcp/ src/__tests__/integration/patentConnector.routes.test.ts
```

Run the full backend suite and build:

```bash
npm test --prefix backend
npm run build --prefix backend
```

Run the targeted frontend tests:

```bash
npm test --prefix frontend -- "src/app/(pages)/settings/features/page.test.tsx" "src/app/(pages)/settings/connectors/page.test.tsx"
```

The stack test `npm run test:stack --prefix backend` needs local Supabase
services running.

An opt-in live test against the real USPTO APIs is manual and needs the
optional credentials. Run the warm-up command, then provision the connector
and run the smoke tests from the activation section.

## Verified

During this implementation, the following commands ran successfully in the
development environment:

```bash
npm test --prefix backend -- src/lib/mcp/ src/__tests__/integration/patentConnector.routes.test.ts
npm test --prefix backend
npm run build --prefix backend
npm test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run typecheck --prefix word-addin
git diff --check
```

The backend image was also verified directly:

```bash
docker build -f backend/Dockerfile -t mike-backend:test .
```

Inside the image, `uv`, `uvx`, and `patent-mcp-server` sat on the PATH, the
tool environment imported cleanly under Python 3.13, and the server started
on stdio. The migration was additionally verified on a disposable PostgreSQL
17 container: it applies, it re-runs safely, the column backfills to off,
the unique index rejects a second managed row per user, the check constraint
rejects other `stdio` identities and `stdio` with bearer auth, and ordinary
HTTP connectors still insert. The full Compose stack and the live USPTO
smoke tests were not executed in the development environment.
