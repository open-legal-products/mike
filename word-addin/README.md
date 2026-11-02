# Mike Word Add-in

The Mike Word add-in brings document-aware chat, workflows, quick actions, and
tracked-edit review into a Word task pane.

It uses the same backend-managed HttpOnly cookie session, Mike API, model
providers, and workflow library as the web app. Word conversations are stored
separately from the web assistant's chat history. Word currently uses the
Personal workspace for models, memory, workflows, quick actions and document
pickers. Organization documents and workflow assets cannot be attached to Word
chats. Older chats with organization attachments must be replaced with a new
Personal chat before continuing; they are also excluded from new Personal
memory learning. This does not purge previously stored chats or memory.

## Prerequisites

- Node.js 22 or newer
- Microsoft Word desktop or Word on the web
- A running Mike backend and Supabase environment configured according to the
  [local development guide](../docs/local-development.md)
- A Mike account
- A model-provider API key or an Ollama model reachable by the backend

## Quick start

With the backend running and configured, run from the repository root:

```bash
bash word-addin/scripts/dev.sh
```

The script installs dependencies, creates `word-addin/.env`, installs the local
HTTPS certificate, verifies Mike, and launches the add-in in Word
unless automatic sideloading is disabled. It is safe to run repeatedly.

The first certificate installation may request your keychain or administrator
password. Fully quit Word and rerun the script afterward so Word reloads the
certificate trust.

Useful options:

```bash
bash word-addin/scripts/dev.sh --setup-only
FORCE=1 bash word-addin/scripts/dev.sh
```

`--setup-only` prepares the environment without launching Word. `FORCE=1`
launches even when the backend health check fails.

For normal development, start webpack directly in the foreground without
opening or sideloading Word:

```bash
bun dev
# or
npm run dev
```

Use `npm start` when you explicitly want automatic sideloading. The
`WORD_ADDIN_SIDELOAD` switch applies only to `npm start` and `scripts/dev.sh`.

## What it supports

- Chat about the open Word document with streamed responses
- Attach Mike library documents and assistant workflows
- Choose from the same supported model providers as the web app
- Apply suggested revisions as tracked changes, then accept or reject them
- Run configurable quick actions such as Proofread and Compare documents
- Create and edit assistant workflows
- Store chat history in Mike Cloud or on the current device only

The add-in requires `WordApi 1.6` for tracked-change review.

## Commands

Run commands from `word-addin/` unless noted otherwise.

| Command                    | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run dev` / `bun dev`  | Start webpack in the foreground without sideloading Word            |
| `npm start`                | Start the HTTPS dev server; sideload unless `WORD_ADDIN_SIDELOAD=0` |
| `npm run stop`             | Stop the sideloaded development session                             |
| `npm run dev:server`       | Internal alias for starting webpack without launching Word          |
| `npm run typecheck`        | Check application and E2E TypeScript                                |
| `npm run build:e2e`        | Build with the hermetic test environment                            |
| `npm run test:e2e`         | Run the mocked Office.js Playwright suite                           |
| `npm run build`            | Create a production bundle and rewritten manifest                   |
| `npm run start:production` | Serve `dist/` and proxy `/api` using `WORD_ADDIN_BACKEND_ORIGIN`    |

## Manual sideloading

The quick-start script is the recommended development path. If automatic
sideloading fails:

- **Word desktop on macOS:** copy `manifest.xml` into
  `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`, restart Word,
  then open **Insert → Add-ins → My Add-ins → Mike**.
- **Word on the web:** open **Insert → Add-ins → Upload My Add-in** and select
  `manifest.xml`. Browser local-network protections can block localhost panes;
  use the included `e2e-live/manual-session.mjs` launcher when needed.

## Development reference

See [Word add-in development and deployment](../docs/word-addin-development.md)
for:

- manual environment and HTTPS setup;
- desktop and web sideloading;
- production builds and CORS configuration;
- cloud and device-only chat-storage behavior;
- automated and keyless testing; and
- certificate, login, upload, workflow, and tracked-edit troubleshooting.
