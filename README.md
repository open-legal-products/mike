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
- [CourtListener integration](docs/courtlistener.md)
- [Microsoft Word add-in](word-addin/README.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Safe local testing](docs/safe-local-testing.md)
- [End-to-end testing and CI](docs/e2e-ci.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Google Drive Integration

Mike can search and read a user's Google Drive files directly from chat — ask
*"Search my Google Drive for the consulting agreement and summarize it"* and
the assistant uses its `google_drive_search` / `google_drive_read_file` /
`google_drive_list_recent` tools (read-only; Google Docs/Sheets/Slides are
exported as text, PDF and Word files are converted). Each user connects their
own Google account with one click from **Account > Connectors > Google
Drive**; tokens are encrypted at rest and access is limited to the
`drive.readonly` scope.

This is a first-party integration over the GA Google Drive REST API. It does
**not** use Google's hosted Drive MCP server, which is gated behind the
Google Workspace Developer Preview Program — no preview enrollment is needed.

### Self-hosting setup (one-time, per deployment)

1. In [Google Cloud Console](https://console.cloud.google.com), pick or
   create a project.
2. **APIs & Services > Library**: enable the **Google Drive API**
   (`drive.googleapis.com`).
3. **APIs & Services > OAuth consent screen**: configure it (External is
   fine). While the app is in *Testing* mode only listed test users can
   connect — add your users, or publish the app. The `drive.readonly` scope
   is *restricted*: serving more than 100 users in production requires
   Google's OAuth app verification.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID >
   Web application**, and add your backend's callback as an authorized
   redirect URI:

       https://<your-backend-host>/user/integrations/google-drive/oauth/callback

   (local development: `http://localhost:3001/user/integrations/google-drive/oauth/callback`)
5. Set the client in `backend/.env` and restart the backend:

       GOOGLE_DRIVE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
       GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=...

   If you already configured `GOOGLE_MCP_OAUTH_CLIENT_ID`/`_SECRET` for MCP
   connectors, the Drive integration reuses them automatically — just add
   the extra redirect URI from step 4 to the same OAuth client.

Fresh databases created from `backend/schema.sql` already include the Drive
token tables. Existing deployments should apply
`backend/migrations/20260804_01_google_drive_integration.sql`.

Each user then clicks **Connect** on **Account > Connectors**, approves the
Google consent screen once, and the assistant's Drive tools activate for
their chats. Disconnecting revokes the grant and deletes the stored tokens.

## System workflows

Mike's system assistant and tabular-review workflows are maintained in the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository. See [Contributing](CONTRIBUTING.md#system-workflows) for how they are
packaged and synchronized with this application.

## License

Mike is available under the [GNU Affero General Public License v3.0](LICENSE).
