# Google Drive: implementation and verification

Mike provides three first-party, read-only assistant tools over Drive REST v3:
`google_drive_search`, `google_drive_list_recent`, and `google_drive_read_file`.
Each Mike user connects their own Google account in Settings → Connectors → Discover. Choose **Add** on the Google Drive card to open Google OAuth directly and select the account there; a connected card offers **Manage**.
The integration does not require a Google MCP server or a service account.

## Technical approach

- **Authorization:** Web application OAuth, PKCE S256, a random state token,
  `drive.readonly`, offline access, and explicit consent. State is hashed in the
  database; its verifier and redirect URI are encrypted. State expires after
  ten minutes. The backend owns the client secret; no token reaches the browser.
  The callback relays to the fixed frontend API gateway and completes only
  with the session of the Mike user who initiated that state; a different user
  or an unauthenticated popup cannot attach a Google grant.

- **Persistence:** both Drive tables have RLS, no user policies, and no
  anon/authenticated grants. The backend service role stores AES-GCM encrypted
  access and refresh tokens using the existing connector encryption helpers.
  The key is `MCP_CONNECTORS_ENCRYPTION_SECRET`, falling back to
  `USER_API_KEYS_ENCRYPTION_SECRET`. Keep it stable across restarts.
- **Atomic completion:** `complete_google_drive_oauth` locks the owning auth
  row, consumes an unexpired state, and writes the tokens in one transaction.
  Replays and cancelled states fail; a failed token write rolls back state
  consumption. These RPCs are executable only by the service role.
- **Refresh:** the assistant refreshes within 60 seconds of access-token expiry.
  An update conditioned on the old encrypted access token prevents a late
  refresh from overwriting a new grant or recreating a disconnected connection.
  A refresh response without a new refresh token preserves the encrypted one.
  A new connection must supply offline access and the requested permission.
- **Disconnect/cancel:** disconnect atomically removes tokens and all pending
  states for that user. It does not revoke the entire Google project grant,
  which would also break Gmail and Calendar sharing the project. To revoke
  every service, remove the app in Google Account settings. Cancel removes just the caller's
  selected attempt; after cancellation the card rechecks status in case consent
  completed first. A disconnected account cannot be recreated by an in-flight
  callback. A new, deliberately initiated connection can still succeed.
- **Data access:** every token query uses the authenticated Mike user ID. Google
  enforces that account's file permissions. Drive content is returned as
  untrusted tool context, using the existing connector activity events. There
  are no Drive write tools. Retrieved content can be included in the chosen
  model's input and persisted chat history, so test with synthetic documents.
- **Errors:** callback HTML, chat events, and tool output contain fixed messages
  for unexpected failures. Intentional reconnect, permission, size, and timeout
  errors have controlled messages. Logs omit exception messages/bodies/stacks
  for this integration, avoiding provider-token and database-detail disclosure.

Code entry points:

| Concern | File |
| --- | --- |
| OAuth, token access, tools | `backend/src/lib/integrations/googleDrive.ts` |
| Streamed HTTP limits and temporary files | `backend/src/lib/integrations/googleDriveHttp.ts` |
| Configurable budgets | `backend/src/lib/integrations/googleDriveLimits.ts` |
| Parser supervisor / child | `googleDriveExtract.ts` / `googleDriveExtractChild.ts` in the same directory |
| Routes and MFA gates | `backend/src/modules/user/user.routes.ts` |
| Database lifecycle | `backend/migrations/20260921_02_google_drive_integration.sql` and `backend/schema.sql` |
| Card and API calls | `frontend/src/app/(pages)/settings/connectors/page.tsx`, `frontend/src/app/lib/mikeApi.ts` |

## File support and resource budgets

Docs and Slides export as plain text. Sheets export as CSV, which includes
**only the first worksheet**; the tool description and returned `limitation`
explicitly say so. PDFs need embedded text (there is no OCR); DOCX, text,
JSON and XML are also supported. Other formats return an unsupported result.
Text is capped at 60,000 characters with `truncated:true` when incomplete.
The assistant must not claim to have read omitted worksheets or truncated text.

Binary and text content stream into a private temporary directory rather than
an API-process buffer. Files are removed in `finally` after success or failure.
OAuth/metadata responses are separately capped at 1 MiB and 30 seconds.
PDF/DOCX extraction runs in a child process without deployment secrets, limited
by heap, elapsed time, and two concurrent parsers per API process. DOCX expansion
is measured from actual decompressed bytes, not trusted ZIP size declarations;
archives with more than 1,000 entries are rejected. A V8 heap budget is not a
hard limit on total process RSS; deployment/container memory limits remain the
outer resource boundary.

Defaults follow Mike's 100 MiB upload allowance for ordinary files. A progressing
transfer may exceed 30 seconds; idle time and total elapsed time are separate.
Operators can set these positive-integer environment values in `backend/.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_DRIVE_MAX_FILE_MB` | `100` | Maximum downloaded file size in MiB |
| `GOOGLE_DRIVE_DOWNLOAD_IDLE_SECONDS` | `30` | Stop after no transfer progress for this long |
| `GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_SECONDS` | `300` | Overall content-download deadline |
| `GOOGLE_DRIVE_PARSE_TIMEOUT_SECONDS` | `60` | Kill a parser exceeding this duration |
| `GOOGLE_DRIVE_PARSER_HEAP_MB` | `256` | V8 heap budget per parser |
| `GOOGLE_DRIVE_DOCX_EXPANDED_MB` | `300` | Maximum decompressed DOCX bytes in MiB |

Invalid/empty/non-positive values use the defaults. Larger settings need
appropriate temporary disk, memory, and proxy/chat request timeouts. Restart or
recreate the backend after changing env values. These limits apply to assistant
reads; they do not limit a user's downloads from Google's own interface.

Google imposes its own **10 MB limit on Workspace `files.export` responses**;
raising Mike's limit does not change that. That limit is distinct from ordinary
PDF/DOCX downloads. See [Google's export reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)
and [first-sheet-only CSV export](https://developers.google.com/workspace/drive/api/guides/ref-export-formats).

## Configure an existing Google client

1. Enable Google Drive API in the Cloud project that owns your OAuth client.
2. On that **Web application** client, register exactly:

   ```text
   http://localhost:3000/api/user/integrations/google-drive/oauth/callback
   ```

   For a hosted test instance use
   `https://YOUR_HOST/api/user/integrations/google-drive/oauth/callback`.
   This is separate from the Supabase Google **sign-in** callback. Keep existing
   callbacks if using the same client for both. Mike email/password login works
   independently of the Google Drive connection.
3. Configure `https://www.googleapis.com/auth/drive.readonly` in Google Auth
   Platform → Data Access. For External/Testing, add your Google account as a
   test user. Internal is for users within the Workspace organization that owns
   the Cloud project; Workspace administrators may need to allow the client.
4. Set the dedicated credentials in `backend/.env`:

   ```dotenv
   GOOGLE_DRIVE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
   GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
   ```

   If neither dedicated value is set, `GOOGLE_MCP_OAUTH_CLIENT_ID` and
   `GOOGLE_MCP_OAUTH_CLIENT_SECRET` are used together. An incomplete dedicated
   pair is a setup error; credentials from different clients are never mixed.
5. Ensure `USER_API_KEYS_ENCRYPTION_SECRET` and `DOWNLOAD_SIGNING_SECRET` are
   configured. Generate each missing secret separately with
   `openssl rand -hex 32`; do not replace existing encryption keys.
6. For Compose, set root `.env` to:

   ```dotenv
   API_PUBLIC_URL=http://localhost:3000/api
   FRONTEND_URL=http://localhost:3000
   NODE_ENV=development
   ```

   Root `.env` takes precedence over `backend/.env` for duplicate values.
   Add a supported model-provider key or a working Ollama model for chat tests.
   If testing Mike email/password login only, set
   `GOTRUE_EXTERNAL_GOOGLE_ENABLED=false` in root `.env`.
7. Follow [local development](local-development.md) for a new stack, preserving
   existing env files, then run `docker compose up --build -d`. Confirm `db-init`
   succeeded with `docker compose ps -a` and its logs. Fresh installs include the
   schema; existing installations need the Drive migration **before** the new
   backend code. If you previously applied an earlier draft of this unmerged
   Drive migration, reapply the current file to install the lifecycle RPCs.

For a confirmed disposable local Compose database, the migration command is:

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < backend/migrations/20260921_02_google_drive_integration.sql
docker compose exec -T db psql -U postgres -d postgres \
  -c "NOTIFY pgrst, 'reload schema';"
docker compose up -d --force-recreate backend
```

No remote database migration is implicit in these instructions.

Google permits HTTP localhost redirects but requires exact matching:
[web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).
`drive.readonly` is a restricted scope. External distribution may require
verification and a security assessment, subject to applicable exceptions:
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
External/Testing refresh tokens expire after seven days. Internal apps avoid
that specific rule, but tokens can still be revoked or expire for other reasons:
[token expiration](https://developers.google.com/identity/protocols/oauth2).

## Manual acceptance tests requiring your Google account

Use a disposable Mike user and synthetic documents. These steps are still
required even when all automated tests pass: mocks cannot establish that your
actual Cloud client, consent configuration and Workspace policy work together.

1. **Configuration:** log in, open Settings → Connectors, and inspect
   `GET /api/user/integrations/google-drive` in browser devtools. Expect
   `configured:true`, `schemaReady:true`, `connected:false`, and the exact
   registered redirect URI. These flags alone do not validate Google credentials
   or prove the lifecycle RPCs were deployed.
2. **Consent:** choose Add on the Google Drive card, then Connect in the details
   dialog. Complete Mike MFA if enrolled, choose your test
   Google account, and approve Drive read access. Expect Connected, including
   after page reload and backend restart. No access/refresh tokens should appear
   in browser API responses. If Google denies consent, close the popup and use
   Cancel in Mike to end its polling attempt; a retry should work.
3. **Search/read:** create `MIKE434 Consulting Agreement` in Google Docs with
   “Payment is due in 17 days. Liability cap is USD 43,210.” Ask Mike to search
   for it, read it, and quote both terms. Verify actual Drive search and read
   activity, not just a plausible answer. Also request the ten most recently
   modified files and check the fixture appears.
4. **Formats:** read small PDF, DOCX, TXT and Slides fixtures with unique markers.
   For Sheets, place different markers on worksheets one and two: only the
   first should be returned, explicitly marked partial. A PNG should report
   unsupported. A file over 60,000 text characters should report truncation.
5. **Larger files:** read a synthetic PDF or DOCX between 10 and 100 MiB. It should
   pass the download-size gate; parsing must finish within the configured
   extraction budgets. If your deployment needs larger/longer reads, raise the
   documented settings and retest. Exceeding a configured budget must give a
   controlled error and leave the app responsive.
6. **Refresh:** confirm `encrypted_refresh_token is not null` in your test user's
   token row without printing its value. On the disposable test DB, run:

   ```sql
   update public.user_google_drive_tokens
   set expires_at = now() - interval '1 minute'
   where user_id = (
     select id from auth.users where email = 'YOUR_MIKE_TEST_LOGIN_EMAIL'
   );
   ```

   Ask for recent Drive files again. Expect success without another consent
   prompt, a future `expires_at`, and a refresh token still present.
7. **Revocation:** remove the app in your Google account's third-party
   connections, force expiry again, then call a Drive tool. Expect reconnect
   guidance and a deleted local token row. Reload Settings and reconnect.
8. **Isolation:** in another browser profile sign into a second Mike user with
   Drive unconnected. It must not use the first user's authorization. Connect
   that user to a different Google account and try the first account's private
   fixture ID; Google must deny access unless that account has file permission.
9. **Cancel/disconnect:** cancel a pending attempt; it must not complete later.
   If consent already completed before cancellation, the card must honestly
   show Connected. Disconnect, reload, and start a new chat: the token row is
   gone and Drive tools are not offered. Google-side revocation is best-effort.
   COOP may prevent Mike from closing Google's popup; close that window manually.
10. **Read-only:** ask the assistant to rename/delete a Drive fixture. No Drive
    write tool exists, and the original must remain unchanged.

Record the tested commit, browser, audience mode, fixture names and pass/fail
results. Do not attach credentials, authorization codes, cookies, refresh
tokens or real client documents to PR evidence.

## Automated verification

From the repository root:

```bash
npm test --prefix backend -- src/lib/integrations/__tests__ src/__tests__/integration/connectors.routes.test.ts src/__tests__/architecture.test.ts src/__tests__/composeMigrations.test.ts --maxWorkers=2
npm run build --prefix backend
npm run typecheck:test --prefix backend
npm run typecheck:contracts --prefix backend
npm run test:coverage --prefix backend
npm run test:coverage --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
git diff --check
```

`googleDrive.supabase.test.ts` additionally exercises real database transactions,
concurrent completion/disconnect, rollback, and anon/owner grant denial. It runs
in the Supabase stack CI job; local setup is documented in
[safe local testing](safe-local-testing.md) and [the stack harness](../backend/scripts/test-stack.sh).
`e2e/google-drive.spec.ts` exercises the real page, popup, cancellation, polling,
and disconnect in Chromium with mocked Google integration endpoints. It runs
in the standard Playwright CI job without Google credentials.

Approve and merge only the exact tested head after all required checks pass,
you understand the permission/data flow and documented limits, and the live
Google checklist succeeds. Changing the client, migration, code or relevant
configuration invalidates the corresponding previous test evidence.
