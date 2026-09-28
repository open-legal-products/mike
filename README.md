# Mike

![Mike](docs/assets/link-image.jpg)

Mike (MikeOSS) is an open-source legal AI platform for document review,
drafting, and legal research.

It combines a Next.js frontend, an Express backend, Supabase Auth/Postgres,
and Cloudflare R2-compatible object storage.

Website: [mikeoss.com](https://mikeoss.com)

![Mike assistant home screen](docs/assets/mike-home.png)

## Features

- Chat with legal documents and open matters
- Review documents and apply suggested edits
- Run reusable assistant and tabular-review workflows
- Organize projects, folders, and a document library
- Verify citations and research US case law with CourtListener
- Work from Microsoft Word with the beta task-pane add-in
- Run supported language models locally through Ollama

## Quick start

The included Docker Compose stack runs Mike, Supabase, RustFS object storage,
and local email capture without requiring managed infrastructure.

1. Copy the local environment templates:

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   ```

2. In `backend/.env`, set `DOWNLOAD_SIGNING_SECRET` and
   `USER_API_KEYS_ENCRYPTION_SECRET` to separate values generated with:

   ```bash
   openssl rand -hex 32
   ```

3. Add an Anthropic, Gemini, or OpenAI API key to `backend/.env`, unless you
   plan to use Ollama exclusively.

4. Start the stack:

   ```bash
   docker compose up --build
   ```

5. Open [http://localhost:3000](http://localhost:3000) and create an account.

The bundled credentials and infrastructure are intended for local development
only. See [Local development](docs/local-development.md) for service endpoints,
authentication behavior, Ollama setup, and first-run guidance.

### Telemetry

Error reports are sent to the Mike project's own Sentry by default, so the
maintainers can fix failures encountered by forks and self-hosted installs.
Before network transmission, every runtime rebuilds reports from an explicit
allowlist: code locations and line numbers, controlled operation labels,
HTTP method/status and normalized routes, validated correlation IDs, release,
and environment. Client document filenames, document text, raw error and
console messages, request URLs/queries/headers/bodies, user identities, and
breadcrumbs are excluded. Automatic sessions, replay, attachments, traces,
and other non-error payloads are blocked. The same boundary applies to
community and official installations. See the [observability guide](docs/observability.md)
for the exact policy, source-map behavior, and limitations.
To opt out, set `SENTRY_DISABLED=true`
(`NEXT_PUBLIC_SENTRY_DISABLED=true` / `REACT_APP_SENTRY_DISABLED=true` for the
browser and add-in builds); to use your own Sentry instead, set the matching
`*_SENTRY_DSN`.

The built-in DSNs are public submission addresses; stored error reports are
accessible to authorized Sentry organization members. The guide documents
[public-DSN and default-on precedents](docs/observability.md#public-dsns-and-default-on-reporting)
(Zulip Desktop, Element Web, and GitLab's distinct Service Ping mechanism),
and [quota protections and remaining limits](docs/observability.md#quota-protection-and-its-limits).

The [Sentry data audit](docs/sentry-data-audit.md) records the original privacy
findings, their fixes, and the current outbound data inventory. Source-map
uploads are separate and send application source code only when operators
configure upload credentials.

## Repository

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js web application |
| `backend/` | Express API, document processing, and database access |
| `word-addin/` | Microsoft Word task-pane add-in (beta) |
| `backend/schema.sql` | Complete schema for fresh databases |
| `backend/migrations/` | Dated migrations for existing deployments |
| `docker-compose.yml` | Local application and infrastructure stack |
| `docs/` | Development, deployment, testing, and feature guides |

## Documentation

- [Documentation index](docs/README.md)
- [Local development](docs/local-development.md)
- [Manual and production deployment](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [MCP connectors](docs/connectors.md)
- [Google Drive integration](docs/google-drive.md)
- [CourtListener integration](docs/courtlistener.md)
- [Microsoft Word add-in](word-addin/README.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Safe local testing](docs/safe-local-testing.md)
- [End-to-end testing and CI](docs/e2e-ci.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## System workflows

Mike's system assistant and tabular-review workflows are maintained in the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository. See [Contributing](CONTRIBUTING.md#system-workflows) for how they are
packaged and synchronized with this application.

## License

Mike is available under the [GNU Affero General Public License v3.0](LICENSE).

## Gmail and Google Calendar

Gmail and Calendar are separate, optional connections in **Settings → Connectors**.
Google SSO never connects them automatically. Choose any permitted Google account
for each service, including a different account from your Mike login. Read access
is the default; write permissions require a separate consent flow, and every
send/edit/delete proposal requires explicit approval of its exact contents.
See [setup, technical approach, limits, and manual acceptance tests](docs/google-workspace.md).
