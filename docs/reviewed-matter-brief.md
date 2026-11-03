# Reviewed matter brief

This local prototype adds a project-bound review checkpoint around an ordinary
versioned DOCX. It is independent of the Gmail intake proposal: sources can be
ordinary uploaded project documents.

1. Upload a DOCX containing the current matter position, then choose **Resume
   matter** on the project's Documents screen and designate that document.
2. Select up to ten source documents and a model configured for the project's
   workspace. Confirm that the current brief and selected source text may be sent
   to that provider. Private account memory and chat are excluded.
3. Review the proposed position, awaiting items, uncertainties and next action.
   Expand the prior brief, inspect the quotations and open the checked sources.
4. Confirm review and project sharing, then **Apply reviewed update**. This saves
   exactly the proposed text as a native DOCX version and records the readable
   source fingerprints reviewed. Unreadable/unselected sources stay outstanding.
5. Reopen later to resume the accepted position and remaining gaps. A manual brief
   edit is flagged separately. Changed source revisions become outstanding again.

Only project editors can designate, propose or apply. Proposals are private to
their author until applied. Accepted brief versions follow ordinary project access.
A stale target/source, deleted or moved document, or expired proposal requires a
fresh proposal. Retrying an applied proposal returns its original version without
reactivating it or making another version. Two proposals from the same base have
one winner. Old live version citations remain usable; an in-place replacement
returns a conflict rather than silently opening different bytes.

This is human review support, not verified advice or deadline calculation. Exact
quotes come from server-supplied source excerpts, not model-written quotation text.
The model selects IDs bound to the source document, version, extraction revision
and hashes; the server resolves IDs only inside that request's evidence packet and
rechecks exact source membership. Excerpts retain every source character without
normalization and are at most 400 characters, preserving whole sentences where
they fit. Very long sentences span excerpts; inspect surrounding original context.
Unknown, stale or foreign references
fail closed. This checks attribution, not whether the excerpt supports the generated
interpretation. Visually check signatures and execution pages in the originals; text
extraction may not capture them. The inventory does not prove the matter file is
complete. Source text is untrusted evidence and cannot trigger tools or writes.

Limits: an existing DOCX brief, 500 project documents, ten selected sources,
100,000 characters per source, 200,000 characters and 30 MB total evidence bytes,
20 MB per source; proposals expire after one hour. Full current extraction and byte
fingerprints are required. Pending/failed/empty/oversized or textless-page extraction
is a gap. Generic project memory remains a separate feature.

Generation permits at most two application completion attempts within one shared
two-minute deadline. Each uses a 6,000-token base output allowance; the existing
adapter can add reasoning headroom for models that require it. Invalid model JSON,
schema or excerpt references may trigger one fresh completion from the original evidence.
A thrown provider/authentication error does not trigger that second completion;
the underlying SDK's existing transient-request retries remain in effect. Each
completion is checked by the same strict validator; only a valid result is staged.
No document or checkpoint is saved
if both fail. The ordinary chat generation rate limiter also applies. Charges may
include both completions and SDK retries; these are not a hard cost/request cap.

Tests use fictional documents and a local model-protocol fixture. In addition to
unit/component and real PostgreSQL/HTTP checks, the actual Next.js development app
was exercised through supported local GoTrue login, onboarding, project entry,
designation, proposal, Apply, immediate document-table refresh, fresh-session resume
and checked source download. Authentication and app routes were not mocked in that
run. Separate live-provider qualification used fictional documents; invalid model
outputs were preserved as failures and drove the source-excerpt and bounded
regeneration behavior.
These checks do not establish general model reliability, prompt-injection
resistance, time savings or production-build coverage.

For a disposable local test database initialized from `backend/schema.sql`:

```sh
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/src/modules/project-brief/__tests__/projectBrief.database.sql
npm test --prefix backend -- src/modules/project-brief/__tests__
npm test --prefix frontend -- src/app/components/projects/ReviewedMatterBrief.test.tsx
```

The SQL fixture rolls back its fictional rows and never changes an existing
permission. Migration `20261102_02_reviewed_matter_brief.sql` must be applied before
using the feature. Sequence 01 is reserved for the separately proposed email intake
migration, avoiding a collision when both contributions are combined.
