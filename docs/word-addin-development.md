# Word add-in development and deployment

This guide contains the detailed setup, deployment, testing, and troubleshooting
reference for the [Mike Word add-in](../word-addin/README.md).

## Architecture

The add-in uses the same backend-managed session and Mike API as the web app:

- Password, Google, refresh, and logout operations go through the Mike backend.
- Chat, workflows, uploads, profiles, and model discovery use the Mike API.
- Word conversations use dedicated `word_*` tables and do not appear in the
  web assistant's normal chat history.
- The task pane requires HTTPS, so local development proxies `/api` to Mike
  through `https://localhost:3200`.

Password and Google sign-in both produce the same HttpOnly cookie session.
Google sign-in uses a non-iframe Office Dialog that starts and finishes at
`https://localhost:3200/oauth-dialog.html`; the intermediate Supabase and
Google pages run outside the task pane. No access or refresh token is available
to task-pane JavaScript or OfficeRuntime storage. The dialog returns only a
request-bound, single-use handoff ticket; the task pane redeems it and receives
its own HttpOnly cookie.

The add-in requires `WordApi 1.6` for tracked-change inspection, acceptance,
and rejection.

## Manual local setup

The recommended path is `bash word-addin/scripts/dev.sh`. To perform the same
steps manually:

1. Install dependencies:

   ```bash
   cd word-addin
   npm install
   ```

2. Copy and edit the environment file:

   ```bash
   cp .env.example .env
   ```

   Local development uses these values:

   ```env
   REACT_APP_API_BASE_URL=https://localhost:3200/api
   REACT_APP_WEB_APP_URL=https://app.mikeoss.com
   API_PROXY_TARGET=http://localhost:3001
   OBJECT_STORAGE_PROXY_TARGET=http://localhost:9000
   OBJECT_STORAGE_BUCKET_NAME=mike
   ```

   The browser-facing API URL remains on the HTTPS dev server; the proxy target
   points to the backend, whose `.env` contains the Supabase configuration.
   Shell variables override `.env` for CI and deployment.

   When the backend uses local object storage, also set
   `R2_PUBLIC_ENDPOINT_URL=https://localhost:3200` in `backend/.env`. Signed
   upload URLs then stay HTTPS in the Word task pane and webpack forwards the
   the configured bucket path to `OBJECT_STORAGE_PROXY_TARGET` without changing
   the signed host header.

3. Install the trusted development certificate:

   ```bash
   npx office-addin-dev-certs install
   ```

   Fully quit and reopen Word after installing it.

4. Start the Mike backend:

   ```bash
   (cd ../backend && npm run dev)
   ```

5. Start and sideload the add-in:

   ```bash
   npm start
   ```

   To start only webpack in the foreground without opening or sideloading Word:

   ```bash
   bun dev
   # or
   npm run dev
   ```

   `WORD_ADDIN_SIDELOAD` applies only to `npm start` and the setup helper.

The task pane appears under **Home → Mike Legal AI → Mike**. `npm run
dev:server` is retained as an internal alias for the direct webpack command.

## Manual sideloading

### Word desktop on macOS

```bash
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

Restart Word, then choose **Insert → Add-ins → My Add-ins → Mike**.

### Word on the web

Choose **Insert → Add-ins → Upload My Add-in**, then select `manifest.xml`.

Chrome's Local Network Access checks can silently block a public Word page from
embedding the localhost task pane. For local Word-on-the-web testing, use the
included persistent browser session:

```bash
node e2e-live/word-web-session.mjs --login
node e2e-live/manual-session.mjs
```

The first command captures a Microsoft login; the second opens Word online and
sideloads the current manifest.

## Production build

Production builds require explicit service endpoints and a public add-in URL:

```bash
cd word-addin
REACT_APP_API_BASE_URL=/api \
REACT_APP_WEB_APP_URL=https://app.example.com \
WORD_ADDIN_PUBLIC_URL=https://word.example.com \
npm run build
```

The build writes task-pane assets and a URL-rewritten manifest to `dist/`.
The checked-in `manifest.xml` remains configured for localhost.

The add-in host must reverse-proxy `https://word.example.com/api/*` to the Mike
backend while preserving `Cookie`, `Origin`, response `Set-Cookie` headers, and
streaming bodies. Keeping `/api` on the task-pane origin avoids third-party
cookie restrictions across Word desktop and Word on the web.

The included production host implements this contract:

```bash
npm run build
WORD_ADDIN_BACKEND_ORIGIN=http://localhost:3001 npm run start:production
```

The Dockerfile packages the same host. It expects TLS to terminate at the
deployment ingress and requires `WORD_ADDIN_BACKEND_ORIGIN` only at runtime.

Identify and allow the deployed task-pane origin in the backend with
`WORD_ADDIN_URL=https://word.example.com`. `ALLOWED_ORIGINS` alone is not
sufficient: the explicit Word setting also selects the partitioned cookie
policy and enables the OAuth handoff. Without it, the backend rejects the
handoff and Word on the web cannot retain its embedded session.
Set `AUTH_HANDOFF_ENCRYPTION_SECRET` and apply
`backend/migrations/20260825_01_auth_handoff_tickets.sql` before enabling Google
sign-in. The backend rejects missing or weak handoff configuration at startup.

For Google sign-in, add
`https://word.example.com/oauth-dialog.html` to the Supabase Auth redirect
allow list. Google's own authorized redirect URI remains the Supabase callback,
for example `https://<project-ref>.supabase.co/auth/v1/callback`.

## Chat and storage behavior

The add-in sends the active Word document to `POST /word-chat` as document
context. The backend adds Word-specific instructions and streams the response.
Suggested edits are rendered as cards and applied as tracked changes for review.

Cloud chat storage uses the backend `word_*` tables. Existing deployments need
the `20260809_01_word_addin_chats.sql` migration; fresh databases already
contain those tables.

**This device only** storage uses IndexedDB and bypasses server persistence.
Those chats are not encrypted by the add-in and remain in the operating-system
profile after sign-out until deleted from Settings. Switching storage locations
does not copy or delete conversations.

Cloud history is associated with an identifier in the Word document's Office
settings. That identifier travels with copied files, although server access is
still scoped to the signed-in Mike account. A same-account **Save As** copy can
therefore initially share the source document's chat history.

## Automated tests

The Playwright suite uses a mocked Office.js host and stubbed backend, so it
does not require Word, Supabase, or a live Mike API:

```bash
cd word-addin
npm run typecheck
npm run build:e2e
npm run test:e2e
```

Before release, also verify a multi-paragraph tracked replacement and its
Accept/Reject actions in a supported Word desktop client, including after the
task pane is closed and reopened.

### Testing without a funded LLM key

The local Anthropic-protocol stub returns scripted streaming responses while
the rest of the stack remains real:

```bash
node e2e-live/anthropic-stub.mjs &
(cd ../backend && ANTHROPIC_BASE_URL=http://127.0.0.1:4141 npm run dev)
```

Its responses are static; use the document examples described in the constants
at the top of `e2e-live/anthropic-stub.mjs`.

## Shared UI maintenance

The task pane is independently bundled. When the web design system changes,
compare:

- `src/shared/styles/tokens.css` with `frontend/src/app/globals.css`;
- `src/taskpane/lib/modelCatalog.ts` with the web model catalog; and
- `src/shared/chat/ChatInput.tsx` and the shared UI primitives with their web
  counterparts, retaining narrow-pane adaptations.

## Troubleshooting

### Word reports an invalid development certificate

Development certificates expire and can be regenerated under a new local CA.
`bash scripts/dev.sh` detects and repairs this trust drift. To repair it
manually on macOS:

```bash
security verify-cert -c ~/.office-addin-dev-certs/localhost.crt -p ssl -s localhost
npx office-addin-dev-certs uninstall
npx office-addin-dev-certs install
security verify-cert -c ~/.office-addin-dev-certs/localhost.crt -p ssl -s localhost
```

If the final check still fails:

```bash
security add-trusted-cert -r trustRoot \
  -k ~/Library/Keychains/login.keychain-db ~/.office-addin-dev-certs/ca.crt
```

Fully quit Word before relaunching with `npm start` because its webview caches
certificate decisions.

### Sideloading reports an existing manifest link

Run `npm run stop`, then retry `npm start`. The `prestart` hook normally clears
stale links left by an interrupted session.

### `office-addin-dev-settings` cannot find `semver`

Run `npm install` inside `word-addin`. `semver` is an intentional direct
development dependency for the Office sideloading tool.

### Port 3200 is already in use

Find and stop the process before restarting:

```bash
lsof -nP -iTCP:3200 -sTCP:LISTEN
```

### The task pane is blank or login fails

Inspect the task pane console, confirm the backend is running, and verify the
Supabase URL and publishable key in `.env` match the frontend configuration.
The URL must not end with a slash.

### Tracked-edit review is unavailable

Confirm the Word host supports `WordApi 1.6`.

### Uploads or workflows fail

Confirm the Mike API is reachable at the configured URL, the object-storage
bucket exists, and the database contains at least one workflow. Check backend
logs for the underlying request error.
