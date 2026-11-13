# Reviewed matter brief (local prototype)

A project member can designate an existing DOCX as its matter brief, select newly
uploaded project sources, and request a proposed update to four sections: current
position, awaiting whom, material uncertainties, and next action. The proposal
includes exact source quotations. It changes no document until an editor explicitly
applies it. Apply makes the generated DOCX the active version; it does not merge
tables, formatting or manual notes absent from the proposal. The previous version
remains in ordinary version history unless deleted. Apply records the exact source revisions
reviewed in the same database transaction. Resume shows the last accepted brief,
manual edits since acceptance, and current sources still outstanding.

This works with ordinary uploaded documents and does not depend on Gmail intake
PR #760. Intake receipts describe imports; this feature records human acceptance.
Project readers see accepted brief state; only editors can propose/apply. A proposal
is private to its author until applied. All applied text becomes project-visible.

The model receives only the selected project's brief and selected, fully extracted
source text. Private chat, account memory and instructions are excluded. Source
text is evidence, never authority for tools or writes. The model has no tools. Dates
and positions remain source assertions; acceptance does not certify legal obligations.
The prior brief is transmitted separately as untrusted `priorBriefContext`, without
excerpt IDs. Index 0 remains reserved for the base revision in stored/display
identities and is rejected as evidence in every section and status. Only the
selected source revisions have citable evidence indices, starting at 1. Existing
positions can be carried forward only when that selected evidence supports them;
the review compares the proposed replacement with the prior document. Pending
legacy self-citing proposals are rejected before staging-byte access or Apply;
applied historical records retain their existing display mapping and replay.

The model selects source-bound excerpt IDs. The server inserts the original source
text and rechecks exact membership; it accepts no model-written quotation field.
IDs incorporate source document/version/revision/hash identities and resolve only
against the current request's immutable evidence packet. Bounded 400-character
excerpts retain all extracted source text, without normalization or duplication.
Whole sentences stay together where they fit; long sentences can span excerpts.
This checks literal attribution, not the truth or semantic support of an interpretation.
The complete schema limits are included in the generation prompt. Invalid model
JSON/schema/excerpt references may be regenerated once from the original evidence within one
shared two-minute deadline (6,000 base output tokens per completion, plus existing
model-specific reasoning headroom). A thrown provider error does not trigger a
second application completion; existing SDK transport retries are unchanged.
Validation remains strict and no invalid attempt is staged or applied. Model
selection uses the normal chat resolver with the project workspace, including
personal/organization saved router-model policy and configured-provider checks.
Outstanding source entries are separate DOCX paragraphs.

Apply compares document identity, active version, storage path, byte hash, text
revision, and extracted-text hash. Same-ID editor saves invalidate proposals. Stable
proposal/version IDs make retries idempotent; concurrent proposals have one winner.
A manual brief edit does not inherit an accepted-review stamp. A replacement
brief starts a fresh UUID designation generation; proposals capture it before model
work, and pending/save/Apply/reviewed-history checks require the current generation.
The review screen separately lists and links every included source revision,
including uncited evidence, before the user confirms the full review checkpoint. Pending, failed,
empty or incomplete extraction remains outstanding; selection is not review.
Historical quotes/fingerprints are retained, but historical source bytes are not
promised where the normal editor replaces them in place.

A live designation cannot be switched to another document; its conflict response
identifies that binding instead of asking for an ineffective proposal refresh.
Replacement is available after the bound document is moved away, archived or deleted.

Audit identifiers, timestamps, source fingerprints and review rows remain at project
scope until project deletion. An AFTER DELETE document trigger scrubs `before_text`,
`content` and `gaps` for every proposal whose base is that physically deleted brief,
including former designations. Version tombstone and DELETE triggers apply the
same scrub when `base.versionId` or the staged/applied output ID matches. Deleting
an accepted output also nulls its stored `accepted_content` duplicate; nontext
accepted snapshot/time metadata can remain. The
migration repairs already deleted/tombstoned references without treating an
uncommitted pending staged version as a deleted applied output.
Current-designation deletion additionally detaches the binding, rotates its generation
and clears active acceptance. A replacement starts without inherited review stamps.
Proposal-text reads require current project authorization plus current project
membership of the base and all included source documents, plus live referenced
base/source versions, even for applied proposals.
The raw bundle also withholds accepted content, snapshot, evidence and time when
there is no live in-project base snapshot, and marks sources unreviewed then.
Accepted cached fields additionally require that accepted version to remain live
in the bound document; deleting an accepted version cannot reveal its cached body. Returning
the unchanged base to the same designation restores its preserved state.
Native already shared derived documents, versions and staged artifacts follow their
ordinary lifecycle; this is not global erasure of source text or all derived copies.
Deleted originals are not preserved for audit, and a deleted applied version returns
not-found on replay.

The 500-active-document guard bounds proposal preparation and save. Existing history,
Apply and checked-source access remain available if the inventory later exceeds that
limit. Resume still snapshots/hashes the inventory once per document, so this is not
a constant-time reader for arbitrarily large projects.

Non-goals: autonomous legal assessment, background inbox scanning, sending email,
calendar/tasks, verified deadline calculation, global matter resolution, generic
memory replacement, or a Matter OS. This prototype requires an existing DOCX brief.
Adapter mechanics use fictional fixtures; separate live-provider qualification also
uses entirely fictional sources. The live-provider qualification and scores below
predate the current noncitable-prior-context prompt/validator revision. No live
provider requalification has been performed for this revision and no current
model-quality claim follows from those earlier runs. Neither substitutes for legal
review or establishes a general improvement in model reasoning over ordinary
project chat.

In the final small matched Sonnet 5.5 comparison, independent AI-agent review
scored ordinary Mike 100/100 twice and the feature 97/100 and 100/100. The 97-point
draft was held unapplied because a proposed causation statement needed correction;
only the adequate 100-point feature draft was used for the explicit Apply test.
This was AI-agent review, not a lawyer's legal approval. It supports a limited
internal review prototype, not a claim of superior reasoning or general reliability.
