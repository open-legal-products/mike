# Project email intake — local prototype

Refresh from Gmail lets a project editor preview a bounded Gmail query and
explicitly import selected messages into that project. It uses that person's
existing Gmail connection for the project's workspace. It does not connect a
mailbox, expand OAuth scopes, send mail, save Gmail drafts, change labels or
mark messages read. No model calls are part of this flow.

In Documents, choose **Refresh from Gmail**, enter a Gmail query, preview a
page, select messages, and confirm that their contents may be shared with
project members. Each page contains at most five messages. A next-page token
means more results exist; it is never treated as a completed mailbox scan.
The last confirmed query/receipt is private to the initiating person and can
be reopened. Importing into an organization project makes the imported
documents visible under the project's ordinary access rules; it does not
share access to the Gmail connection.

## What is imported

- A DOCX text rendering of each selected message, with source message/thread
  IDs, sender, recipients, date as written, subject, and the complete supported
  text body. This is a rendering, not preservation of the original EML or its
  visual formatting. Plain text is preferred within each MIME alternative group; independent
  mixed-message sections are retained. HTML
  conversion does not fetch images or remote resources.
- PDF/DOCX attachments, from inline MIME data or Gmail's attachment endpoint.
  Original bytes and SHA-256 are retained in an immutable document version.
  MIME/name agreement, basic type signatures and byte limits are checked;
  these are not a malware scanner or a guarantee of valid document structure.
- A source-backed receipt of imported, previously imported, excluded, failed,
  processing and deleted items, with links to the exact committed versions.
  Sender/date/subject are source metadata, not independently verified facts.

The receipt describes new source material, not the legal significance of a
change. The documents become available to existing project-chat reading and
citation tools. No automatic legal summary or measured model benefit is claimed.

The initial slice accepts UTF-8/ASCII bodies up to 60,000 bytes, up to 40 MIME
parts and 10 nesting levels, 5 MiB per attachment and 20 MiB per preview page.
Unsupported, encrypted, malformed, oversized, or separately stored text bodies
are reported as unavailable; unsupported attachments are shown as excluded.
Such messages remain explicitly incomplete. Attached EMLs, archives, images,
legacy Office documents and OCR are outside this slice. Visually inspect
original messages and execution/signature pages where relevant.

## Identity, consent and recovery

A private, expiring preview binds the actor, project/folder, workspace,
Google account and current grant, content fingerprints and query. Confirmation
binds the exact selected IDs once; changing the destination or selection
requires another preview. Unselected message excerpts are limited to 500 characters
and removed on confirmation. Unconfirmed previews receive a durable cleanup
job scheduled at expiry (one hour); worker outages or exhausted retries can
delay deletion. Confirmed receipts retain selected source metadata but no body
excerpt. They follow account/project deletion cascades.

Provider identity is `(actor, project, Google account_id, message_id, MIME path)`.
Neither names, subjects, thread IDs nor content hashes replace this identity.
Same-name/byte-identical attachments in distinct MIME parts remain distinct
evidence. A same-account reconnect does not duplicate completed identities;
an old preview must still be reviewed again after a grant replacement.

Every confirmation and item read/write rechecks project authorization and the
enabled workspace-bound connection. An atomic documents-owned transaction
rechecks destination, current role, grant and lease; creates/activates the
version using the existing lifecycle; and marks its provenance imported.
Version failure rolls back both document creation and processed status.
A per-item lease and database uniqueness serialize competing attempts.
Retries retain committed items and retry failures. A document deleted after
import is a tombstone and is never recreated by replaying intake.

Staging registers its storage key and a delayed existing `document.cleanup`
job before bytes are uploaded. The worker protects keys referenced by a live
version and removes abandoned staging after 24 hours. Delayed cleanup and
preview expiry need the existing database-job worker; inspect failed jobs
using ordinary deployment operations. There is no new infrastructure.

No timestamp high-water mark or Gmail history cursor is advanced. The durable
item ledger records the exact processed set. Page/discovery completion,
byte import and successful text extraction remain separate concepts.

External emails and attachments remain untrusted evidence. Their instructions
are never used to select messages, choose destinations, initiate tool calls,
or authorize any action in intake. Later AI review remains subject to Mike's
existing source/tool security boundaries; no model-safety guarantee is made.

## Maintainer proposal and validation

See [the local PRD](project-email-intake-prd.md). The repository asks for a PRD
issue before a feature changes multiple subsystems/API/data model. This local
prototype has not been posted or approved by maintainers. Existing AGPL terms
remain unchanged. It is separate from workflow repositories and other fixes.

Run backend unit/route checks with:

```sh
npm test --prefix backend -- src/modules/project-email/__tests__
npm run build --prefix backend
npm run typecheck:test --prefix backend
npm run typecheck:contracts --prefix backend
npm test --prefix frontend -- src/app/components/projects/ProjectEmailIntake.test.tsx
npm run typecheck --prefix frontend
```

`project-email.database.sql` runs with `psql -v ON_ERROR_STOP=1` against a
disposable local database initialized with `backend/schema.sql`. It rolls back
its fictional fixtures. It tests actual lifecycle/lease/rollback behavior;
the TypeScript service/route/component tests use synthetic provider/storage/DB
mocks. Neither establishes live Google interoperability or browser end-to-end
behavior. Do not apply the migration to an existing user database just to test.

A private Chrome browser fixture also exercised the actual intake component,
API client and notifications against the real backend/database/storage path,
using synthetic Gmail and session middleware. It covered selection/consent,
partial failure/retry, duplicate-safe repeat, reopened receipts, source-link
HTTP success and empty/provider-error/loading states. This used a small test
shell rather than the full authenticated Next application. Live Gmail/OAuth
and the browser permission-revocation case remain unverified. No model calls
were used.
