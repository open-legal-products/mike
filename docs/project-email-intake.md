# Project email intake — local prototype

Refresh from Gmail lets a project editor preview a bounded Gmail query and
explicitly import selected messages into that project. It uses that person's
existing Gmail connection for the project's workspace. It does not connect a
mailbox, expand OAuth scopes, send mail, save Gmail drafts, change labels or
mark messages read. No model calls are part of this flow.

In Documents, choose **Refresh from Gmail**, enter a Gmail query, preview a
page, select messages, and confirm that their contents may be shared with
project members. If the preview marks an email body excluded, selecting that
message imports only its supported attachments. Review the original email for
the missing body or headers. A message with no readable body and no supported
attachments cannot be selected. Each page contains at most five messages. A next-page token
means more results exist; it is never treated as a completed mailbox scan.
The last confirmed query/receipt is private to the initiating person and can
be reopened. Importing into an organization project makes the imported
documents visible under the project's ordinary access rules; it does not
share access to the Gmail connection.

## What is imported

- A DOCX text rendering of each selected message whose body and retained headers
  can be read safely, with source message/thread
  IDs, sender, To/Cc recipients, Reply-To, date as written, subject, and the
  complete supported text body. This is a rendering, not preservation of the original EML or its
  visual formatting. The rendered header subset is From, To, Cc, Reply-To,
  Date and Subject, rather than all RFC headers. Plain text is preferred
  within each MIME alternative group; independent mixed-message sections are
  retained. HTML conversion retains absolute HTTP(S) and mailto destinations
  as inert literal text, without active hyperlinks or fetching images/remote
  resources. Unsupported or relative destinations retain their label text only;
  rendering that exceeds the text/structure limits is unavailable rather than
  silently truncated.
- If a body or retained header cannot be decoded or rendered safely, the preview
  discloses the exclusion before sharing consent. No email text document or
  placeholder is created. Independently identified supported attachments can
  still be imported, and the receipt records the body as excluded with a reason.
  The message remains incomplete even if all supported attachments succeed.
  Invalid retained header fields use explicit unavailable labels; those labels
  are not original source text. The exact original content fingerprint still
  binds the raw headers and MIME content, including the unreadable text.
- PDF/DOCX attachments, from inline MIME data or Gmail's attachment endpoint.
  Original bytes and SHA-256 are recorded at import in an ordinary native
  document version. Native editor saves and explicit version replacement can
  replace those bytes; this intake is not an immutable archive. Save edits as
  a new version to preserve the imported original.
  MIME/name agreement, basic type signatures and byte limits are checked;
  these are not a malware scanner or a guarantee of valid document structure.
- A source-backed receipt of imported, previously imported, excluded, failed,
  processing, deleted, source-changed and source-unverified items. At receipt
  check time, original-source links are shown only while the committed version
  still has the original document identity, storage path and SHA-256. An edited
  or replaced source or missing verification data makes its message incomplete
  and withholds the source link; retry does not overwrite edits or recreate it.
  Sender/date/subject are source metadata, not independently verified facts.

The receipt describes new source material, not the legal significance of a
change. The documents become available to existing project-chat reading and
citation tools. No automatic legal summary or measured model benefit is claimed.

The initial slice accepts UTF-8/ASCII bodies up to 60,000 bytes, up to 40 MIME
parts and 10 MIME nesting levels, 5 MiB per attachment and 20 MiB per preview
page. HTML rendering accepts up to 40 nested element levels and 4,000 children
per element; the combined rendered body must also fit the 60,000-byte limit.
Unsupported charset declarations, malformed base64 or UTF-8, separately stored
bodies, body-specific text/HTML limits, and unsupported control/non-XML
characters exclude the entire email body. A failure in any candidate body or
retained header also excludes the body when another MIME alternative or mixed
section is readable; no partial rendering is presented as the complete body.
These failures do not trigger character stripping, lossy byte decoding, or a
placeholder DOCX. Ordinary TAB/LF/CR whitespace and valid Unicode remain supported.

Ambiguous message identity or MIME structure, MIME part/depth limits, encrypted
content, and aggregate packet/page budget failures remain whole-message
unavailable. Unsupported or unsafe attachment parts are shown as excluded;
attachment download or byte-verification failures remain item failures. Other
independently supported attachments can still succeed. Attached EMLs, archives, images,
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
These checks apply at request, phase and finalization boundaries. An already
authorized overlapping transaction may finish after a concurrent access or
connection change; they do not promise retroactive cancellation. Version failure
rolls back both document creation and processed status. Receipt verification
ignores extraction, filename and rendition metadata updates; it checks the
original source identity/path/hash against the live version.
A per-item lease and database uniqueness serialize competing attempts.
Retries retain committed items and retry failures. An excluded body is terminal
for that confirmation; it is not retried or replaced with a placeholder.
An excluded body with successful attachments offers no ineffective retry, while
a failed or pending attachment can still be retried with the same confirmation.
If a previously readable confirmed message is newly found to have an unavailable
body on re-read, a fresh preview is required so the changed warning can be reviewed.
Older successfully parsed manifests remain supported without an exclusion flag.
Historical committed files are not retrospectively re-rendered or requalified.
Their stored hashes identify bytes, not proof that an older rendering preserved
every original source character.
A document deleted after
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
