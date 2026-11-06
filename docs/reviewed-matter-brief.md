# Reviewed matter brief

This local prototype adds a project-bound review checkpoint around an ordinary
versioned DOCX. It is independent of the Gmail intake proposal: sources can be
ordinary uploaded project documents.

1. Upload a DOCX containing the current matter position, then choose **Resume
   matter** on the project's Documents screen and designate that document.
2. Select up to ten source documents and a model configured for the project's
   workspace. Confirm that the current brief and selected source text may be sent
   to that provider. Private account memory and chat are excluded.
3. Compare the visible current brief with the complete proposed replacement.
   Prior positions, uncertainties, awaiting items and actions absent from it will be
   removed from the active brief; omission does not mean resolution or withdrawal.
   Review the proposed statements, inspect the quotations and open every listed included
   source revision, including sources the model did not cite.
4. Separately confirm revision review and approval of any prior-content omissions,
   then **Apply reviewed update** to share the replacement with the project. This saves
   exactly the proposed text as a new active DOCX version and records the readable
   source fingerprints reviewed. It replaces the active contents; tables, formatting
   and manual notes absent from the proposal are not carried forward. The prior
   version remains available through normal version history unless deleted. Unreadable/unselected sources stay outstanding.
5. Reopen later to resume the accepted position and remaining gaps. A manual brief
   edit is flagged separately. Changed source revisions become outstanding again.

Only project editors can designate, propose or apply. Proposals are private to
their author until applied. Accepted brief versions follow ordinary project access.
A changed target/source, deleted document or expired proposal blocks Apply. A
source currently outside the project also hides pending work and blocks Apply.
Returning the identical source version to the same designation may make an earlier
proposal valid again; movement is not tracked as a permanent invalidation event.
Replacing the designated brief starts a fresh designation generation, even when a
previously designated document later returns. Old proposals and review stamps do
not become current under that new designation. Retrying an applied proposal returns its original version without
reactivating it or making another version. Two proposals from the same base have
one winner. Old live version citations remain usable; an in-place replacement
returns a conflict rather than silently opening different bytes.

A live designated brief cannot be switched to another document through this
prototype. Use its normal editor/version history; a replacement designation is
available once the bound document is moved away, archived or deleted.

Proposal identifiers, timestamps, source fingerprints and review rows belong to the
project until project deletion. Physical deletion of a proposal's base brief clears
its copied prior-brief text, generated content and outstanding-source descriptions,
including proposals from former designations. The same copied-text scrub applies
when a proposal's base version or applied output version is soft-deleted or
physically deleted. Deleting an accepted output also clears its stored accepted-body
cache while leaving nontext audit identity/time records. Deleting the currently designated
brief also detaches it, rotates the generation and clears active acceptance and
review stamps; a new designation starts fresh. A direct proposal-text read requires
current project access, current membership of its base and every included source,
and live referenced base/source versions.
Moved or deleted documents therefore make that text unavailable through the proposal
endpoint. Accepted body, evidence and timestamps are also hidden from a raw
resume response while the designated brief is outside the project or unavailable,
or the accepted version has been deleted.
Review stamps are inactive while the current bound brief is unavailable; retained
source-review records are separate from an accepted output version. Returning an unchanged brief to the same designation
restores that state without rewriting its history. This does not erase already shared derived documents or every copy of a
source quotation: native documents, versions and staged files follow their ordinary
document/storage-cleanup lifecycle. Deleted originals are not preserved for audit.
Replaying an applied proposal whose version was deleted returns not-found.

The prior brief is supplied separately as untrusted context without citable excerpt
IDs. It cannot corroborate its own previous claims: index 0 is reserved and rejected
as a citation, and every proposed entry needs a quotation from the selected source
revisions. Existing positions lacking that support may be omitted; compare the
proposal with the prior brief before accepting it. Pending legacy proposals that
cite the brief itself must be regenerated. Applied historical proposal text remains
readable only while its base and included sources still belong to the current project.
The configured model must pass the same personal/workspace model-resolution policy
as ordinary chat, including saved router-model selections and provider availability.

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

Proposal limits: an existing DOCX brief, 500 active project documents, ten selected sources,
100,000 characters per source, 200,000 characters and 30 MB total evidence bytes,
20 MB per source; proposals expire after one hour. Full current extraction and byte
fingerprints are required. The 500-document limit applies to preparing and saving new
proposals. Existing accepted state, proposal reads, Apply and checked-source downloads
remain available above that limit; a proposal prepared within the limit may still be
applied after the inventory grows. Resume still snapshots and hashes the current
inventory once per document, so large inventories can take longer to load. Pending/failed/empty/oversized or textless-page extraction
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
regeneration behavior. That live-provider qualification predates the current
noncitable-prior-context prompt and validation revision. It has not been repeated
for this revision, and it does not establish its output quality. Current regression
checks use fictional fixtures; no new provider-quality claim is made.
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

Each proposal captures the designation generation before model work. Save and Apply
recheck that generation as well as the source identities. Designating the same
currently bound brief is idempotent. The review screen lists every included source
revision independently of citations, and confirmation covers that entire list.
A historical applied-proposal replay returns its original result while its version
exists, without restoring an older designation or reactivating a version. Deleted
applied versions return not-found.

The revised unmerged migration can be reapplied to a disposable earlier prototype
database. It preserves history and conservatively invalidates legacy proposals
whose designation cannot be established; the currently accepted checkpoint stays
bound. The migration ledger does not automatically replay an already-applied
filename, so pre-merge testers must reset their disposable database or explicitly
reapply the revised prototype migration before using this version.

The before/after confirmations are local review controls using the existing Apply
contract. They reset for each proposal/open/project context and do not certify that
every prior point was preserved or that the selected evidence is complete. Add earlier
supporting sources when needed, or keep the current brief instead of approving its
omissions. Prior context remains noncitable. Late preparation/Apply results from a
previous open or project are discarded by the UI; the original server operation may
still finish for its original project, so reopening that project is the way to inspect it.

Confirmed designation and Apply writes are reported as saved even if a subsequent
read fails. The stale designation form is removed before reloading; its recovery
control retries reads without repeating designation. A failed saved-proposal read
also offers an in-place read retry and blocks another model request until that
read is resolved. Post-Apply brief reload and document-list refresh are attempted
independently within the current open/project context, with notices distinguishing
which view could not refresh.

The designation chooser uses actual DOCX extension/MIME type metadata, compared
case-insensitively. It does not infer type from filenames; missing or unknown type
metadata is not eligible. Other source types remain in the outstanding inventory.
While an operation is pending, both header and footer Close buttons are natively
disabled. A visible header status explains that closing becomes available when
the operation finishes. The feature’s close guard also prevents Escape or backdrop
dismissal while busy; success and failure both restore the close controls. Other
modal callers retain their existing close behavior unless they explicitly disable
their header button.
