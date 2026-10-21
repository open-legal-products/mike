# Google Workspace: Drive, Gmail, and Calendar

Mike connects to Google Drive, Gmail, and Google Calendar as separate,
optional connectors in **Settings → Connectors**. Google SSO never connects
them automatically. Each user chooses any permitted Google account for each
service, including a different account from their Mike login. Read access is
the default; write permissions require a separate consent flow, and every
send/edit/delete proposal requires explicit approval of its exact contents.

The three connectors can share one Google Cloud project and Web application
OAuth client, but each registers its own callback URL.

- [Google Drive](#google-drive)
- [Gmail and Google Calendar](#gmail-and-google-calendar)

## Google Drive

Mike provides first-party read and write assistant tools over Drive REST v3.
Reads are `google_drive_search`, `google_drive_list_recent`, and `google_drive_read_file`.
Writes create text files or Google Docs, create folders, rename or describe items,
replace plain-text/Google Doc contents, move and copy files, and trash or restore items.
Each Mike user connects their own Google account in Settings → Connectors → Discover. Google Drive works like every other connector there: **Add** opens Google OAuth directly (showing **Adding...**, then **Cancel** while Google's window is open), the Discover card then shows **Added**, and the connector appears under **Installed** with an on/off switch. Its Manage dialog switches individual tools on or off, offers a **Read-only** override that disables every write tool while preserving individual choices, configures whether writes need approval, and deletes the connection. If the server has no Google OAuth app configured, **Add** shows the same **Could not add connector** warning as Slack, with setup steps and a guide link.
The integration does not require a Google MCP server or a service account.

Mike asks Google only for the `drive.file` scope, so it reaches two kinds of
files: files Mike created, and files the user explicitly added. To add files,
open the Google Drive connector's **Manage** dialog and choose **Add files from
Google Drive**. Google's own file chooser (the Google Picker) opens over the
page; the user selects one or more files, and Mike reports how many were added
(or that none were). From then on the assistant can search, list and read
those files. Everything else in the user's Drive stays invisible: search and
list do not return it, and the assistant tells the user to add a file it
cannot find. Folders can be browsed in the Picker but not selected, because
picking a folder does not give Mike its contents; select the files inside
instead. The button appears only when the server has the Picker configured
(see below).

### Technical approach

- **Authorization:** Web application OAuth, PKCE S256, a random state token,
  `drive.file` access, offline access, and explicit consent. `drive.file` is
  non-sensitive and grants read and write on files Mike created or the user
  picked. OpenID/email identifies the selected account for the Manage dialog;
  connections made before it was recorded show no account until connected
  again. Legacy grants keep working unchanged: connections that hold the full
  `drive` scope keep full read and write access, and the earliest connections
  that hold `drive.readonly` keep working for reads; either moves to
  `drive.file` when the user deletes the connector and connects it again.
  One table in `googleDrive.ts` (`driveScopeGrants`) decides what each scope
  allows. State is hashed in the database; its verifier and redirect URI are
  encrypted. State expires after ten minutes. The backend owns the client
  secret and the refresh token.
- **Google Picker:** the Picker runs in the browser, so
  `POST /user/integrations/google-drive/picker-session` (signed in, MFA step-up
  when enrolled) hands the browser a short-lived `drive.file` access token,
  refreshed first when it is near expiry, together with the Picker browser key
  and app id. The response is `Cache-Control: no-store` and never includes the
  refresh token, which stays server-side. It answers 404 when the Picker is not
  configured and 409 when Drive is not connected or is switched off.
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
  are no permanent-deletion or sharing-permission tools. Retrieved content can be included in the chosen
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
| Google Picker | `frontend/src/app/lib/googlePicker.ts`, `frontend/src/app/components/settings/useGoogleDrivePicker.ts` |

### Write actions and approval

Apply `backend/migrations/20261002_01_google_drive_writes.sql` to existing
installations. Fresh installs include it in `backend/schema.sql`. It adds a
connection identity and the same `require_write_approval` setting used by the
other connectors. The default is off; users can turn on **Ask for permission for
write actions** in the connector's Manage dialog. Reconnecting rotates the
connection identity and keeps all tool/approval settings.

| Tool | Behavior |
| --- | --- |
| `google_drive_create_file` | Creates a plain-text file or imports plain text into a Google Doc; optional parent folder. |
| `google_drive_create_folder` | Creates a folder, optionally nested. |
| `google_drive_update_file` | Changes a file/folder name or description. |
| `google_drive_replace_file_content` | Replaces all contents of a plain-text file or Google Doc, including existing Doc formatting. |
| `google_drive_move_file` | Moves to a destination folder; inherited access may change. |
| `google_drive_copy_file` | Copies a file under a new name; folders are not supported. |
| `google_drive_trash_file` | Moves an item to Trash; folders affect their contents. |
| `google_drive_restore_file` | Restores an item from Trash. |

Content writes accept up to 60,000 characters. Binary file upload and editing
PDF, DOCX, Sheets, or Slides contents are not implemented. The model is told to
read the complete source before proposing a full content replacement. The
approval card shows the submitted contents and explains the replacement.
Google Docs imports follow Google's [upload and conversion API](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Approval-required writes pause inside the assistant turn. Only a persisted
explicit approval can run them; rejection does not make a write request. The
server rechecks the actor's Drive write grant, current connection identity,
connector switch, and tool switch. Reconnected or disabled grants invalidate
pending approvals. Source and destination metadata are shown for review, and
their versions are checked again before execution. When Google supplies an
ETag, PATCH requests also send `If-Match`; without an ETag the version check is
best effort and cannot exclude a concurrent edit between the read and write.

A mutation is attempted once. A timeout, transport failure, or Google server
error after submission reports an uncertain outcome and asks the user to check
Drive before trying again. It is never automatically retried. Permanent deletion
and permission/sharing changes are not exposed.

### File support and resource budgets

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

### Configure an existing Google client

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
3. Configure `https://www.googleapis.com/auth/drive.file`, `openid`, and
   `.../auth/userinfo.email` in Google Auth Platform → Data Access. For External/Testing, add your Google account as a
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
5. To show **Add files from Google Drive**, enable the **Google Picker API** in
   the same Cloud project, alongside the Google Drive API. Create an API key
   (APIs & Services → Credentials → Create credentials → API key) and restrict
   it the way Google's Picker guide requires: under **API restrictions**
   select both the Google Picker API and the Google Drive API; under **Website
   restrictions** add this deployment's origin (for example
   `http://localhost:3000/*`) **and** `https://docs.google.com/*`, which the
   Picker's own frame loads from. Without the docs.google.com entry the Picker
   opens and then reports "API developer key is invalid" although Mike shows
   the button. Copy the project **number** from Project settings. Then set:

   ```dotenv
   GOOGLE_DRIVE_PICKER_API_KEY=YOUR_BROWSER_API_KEY
   GOOGLE_DRIVE_PICKER_APP_ID=YOUR_PROJECT_NUMBER
   ```

   The key is sent to the browser, so never reuse a server key. Without both
   values the button is hidden and users can only work with files Mike created.
6. Ensure `USER_API_KEYS_ENCRYPTION_SECRET` and `DOWNLOAD_SIGNING_SECRET` are
   configured. Generate each missing secret separately with
   `openssl rand -hex 32`; do not replace existing encryption keys.
7. For Compose, set root `.env` to:

   ```dotenv
   API_PUBLIC_URL=http://localhost:3000/api
   FRONTEND_URL=http://localhost:3000
   NODE_ENV=development
   ```

   Root `.env` takes precedence over `backend/.env` for duplicate values.
   Add a supported model-provider key or a working Ollama model for chat tests.
   If testing Mike email/password login only, set
   `GOTRUE_EXTERNAL_GOOGLE_ENABLED=false` in root `.env`.
8. Follow [local development](local-development.md) for a new stack, preserving
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
`drive.file` is a non-sensitive scope, so external distribution needs brand
verification but not the security assessment that the restricted `drive` scope
requires: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview).
External/Testing refresh tokens expire after seven days. Internal apps avoid
that specific rule, but tokens can still be revoked or expire for other reasons:
[token expiration](https://developers.google.com/identity/protocols/oauth2).

### Manual acceptance tests requiring your Google account

Use a disposable Mike user and synthetic documents. These steps are still
required even when all automated tests pass: mocks cannot establish that your
actual Cloud client, consent configuration and Workspace policy work together.

1. **Configuration:** log in, open Settings → Connectors, and inspect
   `GET /api/user/integrations/google-drive` in browser devtools. Expect
   `configured:true`, `schemaReady:true`, `connected:false`, and the exact
   registered redirect URI. These flags alone do not validate Google credentials
   or prove the lifecycle RPCs were deployed.
2. **Consent:** choose Add on the Google Drive card. Complete Mike MFA if
   enrolled, choose your test
   Google account, and approve access to the Drive files you use with Mike. Expect Google Drive under
   Installed, including after page reload and backend restart. No refresh token should appear
   in browser API responses; only the picker-session response carries a short-lived access token. If Google denies consent, close the popup and use
   Cancel in Mike to end its polling attempt; a retry should work.
3. **Search/read:** create `MIKE434 Consulting Agreement` in Google Docs with
   “Payment is due in 17 days. Liability cap is USD 43,210.” Ask Mike to search
   for it first: it must not be found, and Mike should tell you to add it. Then
   open Manage → **Add files from Google Drive**, pick the document, and expect
   “Added 1 file.” Ask again; Mike should find it, read it, and quote both terms. Verify actual Drive search and read
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
   If consent already completed before cancellation, Google Drive must honestly
   appear under Installed. Switch it off: Drive tools are not offered. Delete
   it, reload, and start a new chat: the token row is gone and Drive tools are
   not offered. Google-side revocation is best-effort.
   COOP may prevent Mike from closing Google's popup; close that window manually.
10. **Read-only grant:** with an older `drive.readonly` connection, ask the assistant to rename/delete a Drive fixture. No Drive
    write tool exists, and the original must remain unchanged.

Record the tested commit, browser, audience mode, fixture names and pass/fail
results. Do not attach credentials, authorization codes, cookies, refresh
tokens or real client documents to PR evidence.

### Automated verification

From the repository root:

```bash
npm test --prefix backend -- src/lib/integrations/__tests__ src/__tests__/integration/connectors.routes.test.ts src/__tests__/architecture.test.ts src/__tests__/migrationLedger.test.ts --maxWorkers=2
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
the Manage dialog and Delete in Chromium with mocked Google integration endpoints. It runs
in the standard Playwright CI job without Google credentials.

Approve and merge only the exact tested head after all required checks pass,
you understand the permission/data flow and documented limits, and the live
Google checklist succeeds. Changing the client, migration, code or relevant
configuration invalidates the corresponding previous test evidence.

## Gmail and Google Calendar

Drive, Gmail, and Calendar are delivered together in [PR #434](https://github.com/open-legal-products/mike/pull/434). The Gmail/Calendar design is recorded in [#521](https://github.com/open-legal-products/mike/issues/521).

### User behavior

**Connecting is always opt-in, including for users who sign into Mike with Google.** Mike sign-in tokens are never reused for Gmail or Calendar. Gmail and Calendar behave like every other connector in Settings → Connectors. In **Discover**, choose **Add**: the button shows **Adding...** while Mike starts authorization and **Cancel** while Google's window is open. There is no Mike account-selection dialog. After authorization, the Discover card shows **Added** and the connector appears under **Installed** with an on/off switch. Click it to open the same Manage dialog Slack uses: account, **Read-only** (disable write tools while preserving individual choices), **Ask for permission for write actions**, a switch per tool, **Refresh**, and **Delete**. If the server has no Google OAuth app configured, **Add** shows the same **Could not add connector** warning as Slack, with the server's setup steps and a guide link. Google shows an account chooser: choose a personal Gmail or Workspace account, including one different from your Mike login and different accounts for Gmail and Calendar. Each Mike user has one connection per service; choosing another account replaces that service's connection but keeps its settings.

Workspace administrators and Google Cloud audience settings can restrict which accounts may authorize the app. Configure an External audience to support accounts outside the Cloud project's organization. Testing mode also requires those accounts in the test-user list. Account selection cannot override Google's policy.

Mike asks Google for read and write access on every connect. Google's consent screen lets the user untick permissions, and Workspace administrators can block them; if write access is withheld, the connection works read-only and the write tools are hidden from the assistant. To gain write access, delete the connector in the Manage dialog and connect it again.

By default the assistant runs write actions directly, as it does for every connector. Turn on **Ask for permission for write actions** in the connector's Manage dialog to review each one first. The assistant's turn then pauses with an approval in the same popup it uses for questions: it shows the exact account, recipients, content, and affected item. **Approve** runs that action and the turn continues with its result; **Reject** tells the assistant it did not run. The approval is part of the conversation, so it survives a reload. An action a [subagent](subagents.md) asks for reaches the user the same way, marked with the subagent's task, and pauses the whole answer. Individual tools can also be switched off in the Manage dialog.

| Service | Reads | Changes |
| --- | --- | --- |
| Gmail | Search messages, read messages/threads, list labels, list/read drafts | Send new plain-text email; create/replace/delete drafts |
| Calendar | List calendars, search/list events, read individual events | Create, patch, or delete a single event or recurring occurrence; Google notifies attendees |

Gmail access is limited to reading mail, sending new mail, and managing drafts: Mike cannot change labels, archive, trash, or delete received or sent messages. Draft deletion removes the draft. Sent email body editing is not supported. Draft replacement is plain text and rejects drafts with attachments or reply headers, so it cannot silently discard attachments or detach a reply from its conversation. Sending attachments, sending existing drafts, email-thread replies, calendar administration, and entire recurring-series mutations are outside this version. Attendee changes replace the attendee list; the approval shows the new list and the existing event.

### Operator setup

1. Apply `backend/migrations/20260922_01_google_workspace.sql`, `backend/migrations/20261001_01_connector_write_access.sql`, and `backend/migrations/20261002_03_connector_read_only.sql` to the intended deployment after the Drive migration. Fresh installs include their final schema in `backend/schema.sql`; Compose's db-init applies them with `backend/scripts/migrate.sh`. No remote database changes are performed by the tests below.
2. Enable **Gmail API** (`gmail.googleapis.com`) and **Google Calendar API** (`calendar-json.googleapis.com`) in the OAuth client's Google Cloud project. These are the REST APIs, not the Google MCP preview services.
3. Configure a Web application OAuth client. The existing Drive client may be reused. Register these exact local redirect URIs:

   ```text
   http://localhost:3000/api/user/integrations/gmail/oauth/callback
   http://localhost:3000/api/user/integrations/google-calendar/oauth/callback
   ```

   Production uses the corresponding `<API_PUBLIC_URL>/user/integrations/.../oauth/callback`. The Next.js gateway on 3000 forwards to Express on 3001. SSO retains its separate Supabase callback; adding these callbacks does not change sign-in behavior.
4. Set `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID` and `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET` in backend environment. If both are absent, the complete Drive/MCP credential profile is reused. An incomplete dedicated pair fails closed. Preserve the encryption secret used by the parent integration; never rotate it as a setup workaround.
5. Add these consent scopes. Mike requests all of them on connect; the write permission is the one users or administrators may withhold. Gmail connections made before Mike moved from `gmail.modify` to `gmail.compose` keep read and write access without reconnecting, because `gmail.modify` covers both narrower scopes; a project that still lists `gmail.modify` on its consent screen can remove it:

   | Connection | Read permission | Write permission |
   | --- | --- | --- |
   | Gmail | `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.compose` |
   | Calendar | `openid`, `email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly` | `https://www.googleapis.com/auth/calendar.events` |

   OpenID/email identifies the selected account for the Manage dialog and approvals. No Mike login email is passed as a hint or used to restrict account choice. Each deployment's OAuth audience and use determine Google's verification requirements; see the self-hosting guidance below, [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).
6. Optionally set `GOOGLE_WORKSPACE_DISABLED_PROVIDERS` to switch a service off for the whole deployment, for example `GOOGLE_WORKSPACE_DISABLED_PROVIDERS=gmail` while a Cloud project's Gmail scopes are still unverified. Discover stops offering that service, `POST /user/integrations/<provider>/oauth/start` answers `404 connector_unavailable`, and the assistant is given none of its tools. A connection made before the switch stays under Installed, with its status reporting `available: false`, so the user can delete it; its tools are not offered and direct calls are refused. Unknown ids are logged and ignored. Keep the Cloud Console's Data Access list equal to the scopes of the services that remain on.
7. Restart the backend after environment changes. In Testing mode, add each intended Google account as a test user. Verify that the saved client ID matches the one used by Mike; enabling an API does not fix an OAuth redirect mismatch.

### Shipping to self-hosted deployments

This feature ships as software that each operator configures and hosts. **Every deployment supplies its own Google Cloud project and OAuth client.** Mike does not distribute a shared client secret, and releasing this PR does not require publishing one central Mike OAuth app for all installations. A successful test of our development client does not authorize a customer's client.

Choose the audience for the accounts that will connect to that installation:

| Deployment | Google configuration | Remaining operator work |
| --- | --- | --- |
| One Workspace organization, only its members | An organization-owned project with an **Internal** OAuth audience | A Workspace administrator may need to allow the client and requested services/scopes. Internal apps qualify for Google's internal-use verification exception; external Gmail accounts cannot connect. |
| Development or evaluation with personal Gmail or external accounts | **External / Testing**, with every account explicitly listed as a test user | Suitable for acceptance tests, not unattended long-term use: these scopes receive refresh tokens that expire after seven days, and test-user limits apply. |
| An installation serving accounts outside its organization | **External**, with publication/verification appropriate to that deployment | Complete branding, authorized domains, public policy information, and Google's sensitive/restricted-scope verification or establish an applicable exception. Restricted-scope server-side use can require a security assessment. Self-hosting alone is not a verification exception. |

Google also documents personal-use and development/testing exceptions. Operators must use the exception that actually describes their deployment; changing the audience to Internal to remove a warning would exclude users outside that organization. Workspace administrators can block an app even when it is verified. See [Google's audience settings](https://support.google.com/cloud/answer/15549945), [verification exceptions](https://support.google.com/cloud/answer/13464323), [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

For each production installation:

1. Apply the Drive and Workspace migrations through the normal deployment procedure; configure a stable encryption secret and keep all OAuth secrets on the backend.
2. Enable Drive, Gmail, and Calendar REST APIs in that installation's project and configure the read and write scopes above. An organization that must not grant write access can block the write scopes in its Workspace admin console; connections then work read-only.
3. Set `FRONTEND_URL` and `API_PUBLIC_URL` to the installation's public HTTPS origins. Register all three exact callback URLs derived from `API_PUBLIC_URL`, ending in `/user/integrations/{google-drive,gmail,google-calendar}/oauth/callback`. For a same-origin gateway, `API_PUBLIC_URL=https://mike.example.com/api`; for a separate public API, it may be `https://api.example.com`. Preserve the separate Supabase SSO callback if Google sign-in is enabled.
4. Complete the audience-specific Google and Workspace-admin steps above, restart Mike, and run the acceptance checklist with synthetic data using that installation's own client.
5. Verify connection with and without write access, direct writes, approval/rejection with **Ask for permission for write actions** on, token refresh after restart, account replacement, and Delete. Keep the resulting proof with the deployment record.

Locally, the recommended callback origin is `http://localhost:3000/api`: Next's gateway forwards the server request to Express on `3001`. The fact that the frontend also uses port 3000 does not make the OAuth code exchange browser-side. Registering port 3001 instead works only when Mike is configured to emit that exact direct-API callback; changing Google's setting alone creates a mismatch.

### Technical approach and boundaries

- `googleWorkspaceAuth.ts`: explicit provider-scoped, per-user PKCE OAuth state, offline access, encrypted credentials, identity from Google's authenticated userinfo endpoint, and refresh compare-and-set. OAuth callbacks relay to a fixed `FRONTEND_URL` gateway, where completion requires the authenticated Mike user who initiated that state (including MFA when enrolled). This also works when `API_PUBLIC_URL` is a separate API origin. OAuth states expire after ten minutes and are consumed atomically with token replacement. Disconnect removes pending states before a late callback can save credentials. Refresh cannot resurrect a disconnected/replaced grant.
- `googleWorkspaceApi.ts`: allowlisted tools and strict argument schemas over Google's REST APIs. Message body conversion returns plain text; attachment content is omitted. Google responses have an 8 MiB / 30-second bound; message previews cap at 60,000 characters, thread reads at 20 messages/3,000 characters each, result pages at 25, and overall serialized tool results at 120,000 characters. Larger results require narrower searches. Truncation is explicit. Retrieved text is untrusted model context and may become part of the selected model's input and stored chat history, just like Drive.
- `googleWorkspace.ts`: builds the assistant's tools from the grant: nothing while the connection is off, no switched-off tools, and no write tools unless Google granted write access. Each call re-checks those settings. A write runs directly unless the connection asks for permission; then `planGoogleWorkspaceCall` prepares the action (reading the item it changes, and the Calendar ETag) and returns an approval item bound to the current `grant_id`.
- Approvals use the assistant's `ask_inputs` pause (`modules/chat/engine/tools/connectorApprovals.ts`), shared with MCP connectors. The approval item is stored on the paused assistant message. The client sends only `approve` or `reject`; the one-step `append_chat_ask_inputs_response` RPC that makes answers single-use records it, and only then does the server run the stored action. It refuses to run if the grant was replaced, write access was withdrawn, or the tool or connection was switched off. The result is appended to the same message and the turn continues. Surfaces without that continuation (the Word add-in, tabular review) refuse writes that need approval instead.
- `useGoogleConnector.ts` and the connectors page: Google connectors use the same Discover card, Installed card, `ConnectorDetailsModal`, and **Could not add connector** warning as MCP connectors. OAuth cancellation covers the Google window, and MFA retries reopen it. A reconnect waits for a new grant rather than treating the existing connection as success.
- RLS is enabled and browser roles have no direct grant/state table or lifecycle-RPC access. Mutation routes, including connector settings, require authentication, trusted-origin checks through existing auth middleware, and MFA when enrolled. Account deletion cascades both tables.
- Calendar patch/delete uses the ETag read when the action was prepared via `If-Match`, rejecting changes made in between. Entire recurring series are rejected. Gmail does not offer equivalent conditional draft writes: Mike checks draft message ID/history before execution, but a concurrent Gmail edit after that check can still race. Avoid editing a draft in Gmail while approving its replacement in Mike.
- Writes are **at most once**, not exactly-once delivery. If a request fails after it reached Google, the outcome is reported as uncertain and never retried automatically; if the server stops after an approval is recorded but before its result is saved, the assistant is told the outcome is unknown. Inspect Google before asking again. Delete cannot retract a request already in flight.
- Deleting Gmail or Calendar removes that local connection without Google-wide revocation, because revoking a shared OAuth client can invalidate the other services too. Remove all access in Google's account settings when desired. Drive uses the same local-only behavior. Google project-wide revocation would invalidate all services and OAuth clients sharing that grant.
- Approved actions and their results are stored in the conversation like other tool activity. Tokens are never returned to the model or logged.

### Manual acceptance checklist

Use two test Google accounts and synthetic mail/events; do not use real client information. Record the commit, browser, accounts (redact as appropriate), and result for each step.

1. Sign into Mike with Google SSO. Both cards must appear in Discover with an Add button, and the assistant must have no Gmail/Calendar tools. Repeat with password login. Merely visiting settings must not open consent.
2. Connect Gmail using a different Google account from the Mike login, unticking the write permission on Google's consent screen. Verify it connects read-only and no write tools are listed. Verify the chooser and connected email. Connect Calendar using another account. Reload and restart: the correct service-specific identity persists.
3. Search for a synthetic email marker and read the message and thread. Verify text, headers, labels, attachment metadata, pagination, and truncation. List calendars and events in a known time range, including an all-day event and a recurring occurrence.
4. Ask to send/edit/delete while connected read-only. No mutation occurs. Delete the connector, connect it again, and grant write access; the write tools then appear.
5. With **Ask for permission for write actions** off, ask for a new email to a test recipient: exactly one email is sent. Turn the setting on and ask again: the turn pauses on an approval showing every recipient, subject, body, and the connected account, and nothing is sent. Approve it: exactly one email is sent and the assistant continues with the result. Reload and double-click must not send it again. Reject a second request and verify no send.
6. Create a draft, replace its content, and delete it. Try header-injection text, attachment-bearing draft replacement, and reply-draft replacement; all must be rejected safely.
7. Create a calendar event with a test attendee, then edit and delete it. Verify invitation/update/cancellation notices. With approvals on, change an event directly in Calendar after the approval appears: approving must reject the stale version. Entire recurring-series edits must be rejected; a single occurrence is supported.
8. Switch off a tool, then the whole connection: the assistant must lose those tools. With an approval pending, change Google accounts or delete the connection: approving must not run against either account. A second Mike user must not be able to answer the first user's approval.
9. Cancel immediately after clicking Add, close the popup, and test with popup blocking. Confirm retry works without a dangling authorization. For MFA-enrolled users, test connection, reconnect, settings changes, and Delete through the verification prompt.
10. Revoke the Google grant externally, then exercise token refresh: show reconnect guidance without exposing provider errors. Simulate a dropped mutation response: show an uncertain outcome and do not retry automatically.

Live Google consent and external mutation checks are required in addition to mocked tests. They cannot pass until the real Cloud client's APIs, callbacks, audience, and scope settings are correct.

### Automated checks

```bash
npm test --prefix backend -- src/lib/integrations/__tests__/googleWorkspace.test.ts src/__tests__/integration/googleWorkspace.routes.test.ts
bash backend/scripts/test-google-workspace-db.sh
npm test --prefix backend -- src/modules/chat/engine/__tests__/connectorApprovals.test.ts src/modules/chat/engine/__tests__/googleWorkspaceDispatch.test.ts
npm test --prefix frontend -- "src/app/(pages)/settings/connectors/page.test.tsx" src/app/components/assistant/AskInputPopup.test.tsx src/app/lib/mikeApi.test.ts
npx playwright test e2e/google-workspace.spec.ts e2e/connector-approval.spec.ts
npm run build --prefix backend
npm run typecheck:test --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
```

The database script uses a new throwaway PostgreSQL container, no host ports, and removes it on exit. It verifies actual grants/RLS configuration, cross-provider and replayed authorization, write access following the granted scopes, settings surviving a reconnect, and migration replay. It never connects to your configured Supabase database.

PR #434 contains the complete integration and targets `main`. It includes both migrations and all three service connections; there is no separate child PR to merge. CI verifies application builds/tests, production images, schema drift, security, Supabase, browser behavior, and the Word add-in.
