# PRD: Explicit project-linked Gmail intake

## Problem

Mike can search/read Gmail and read project documents, but its native Gmail
reader returns attachment metadata without importing bytes. Resuming a file
requires manually finding mail, downloading attachments, uploading them,
and remembering what was already processed. A prompt alone cannot provide
durable import identity, permission checks or crash-safe attachment intake.

## Proposed solution

Add **Refresh from Gmail** to an existing project's Documents view. The editor
previews a bounded query using their workspace's existing private connection,
selects exact messages, and confirms sharing the sources with project members.
Import readable message text and supported attachment bytes once, then show
a persisted, version-linked change receipt. Reopening restores the last query
and incomplete confirmation for retry. No background or inbox-wide process.

## Non-goals

No new matter database/dashboard, automatic matter matching, silent inbox
crawling, scheduled sync/history cursors, send/draft/label actions, new OAuth
grants, arbitrary file types, automatic legal conclusions, or new model costs.
The receipt establishes which evidence arrived, not what legal action to take.

## Technical approach

- Reuse project roles/workspace ownership and existing Gmail grant/token/GET
  transport, without advertising a new assistant tool or broadening scopes.
- Add private expiring previews and a per-source durable item ledger, with
  database uniqueness, leases and explicit incomplete/excluded states.
- Read bounded full MIME and inline/remote attachment bytes. Import messages
  as labelled text DOCX renderings, PDF/DOCX attachments as original bytes.
- Finalize version activation/provenance in one documents-owned transaction,
  reusing `create_document_version`, storage and cleanup/indexing machinery.
- Add a small project control using established modal/input/button primitives.
  No settings screen or additional connector credentials.
- Keep source instructions inert; avoid remote HTML resources, unsafe paths,
  silent truncation, misleading completeness and duplicate reimports.

## Alternatives and overlap

[Matter OS #187](https://github.com/open-legal-products/mike/pull/187) proposed
a broad workspace/knowledge layer. The maintainer requested CLA/screenshots
and later closed the branch pending follow-up, rather than rejecting this
narrow intake design. This proposal does not revive that workspace.

[Upload duplicates #539](https://github.com/open-legal-products/mike/pull/539)
adds advisory current-version byte-hash warnings. It deliberately excludes
a server-side upload guard. Intake needs durable source identity and atomic
processing receipts; hashes still verify bytes, but do not merge provenance.
No code from that open PR is copied or required.

## Success criteria

With fictional provider fixtures, preview performs no import; unconfirmed or
foreign selections cannot import; the destination and private grant remain
bound across confirmation; repeated/concurrent confirmation creates at most
one document/version per identity; failures remain retryable/incomplete;
deletion never causes resurrection; every claimed imported source links to
its committed version. Existing app/setup and unrelated contributions remain
unchanged. No live mailbox or paid model is needed to exercise the contract.

## Open maintainer questions

Is this manual project-level entry point the desired first product slice?
Are PDF/DOCX and rendered email text appropriate initial formats, or should
native EML preservation precede shipping? Are the private preview retention
and account/project receipt lifecycle policies suitable? Confirm those before
production rollout; this is a local review prototype, not a submitted feature.
