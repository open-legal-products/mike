# Reviewed matter brief (local prototype)

A project member can designate an existing DOCX as its matter brief, select newly
uploaded project sources, and request a proposed update to four sections: current
position, awaiting whom, material uncertainties, and next action. The proposal
includes exact source quotations. It changes no document until an editor explicitly
applies it. Apply adds a native DOCX version and records the exact source revisions
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
Validation remains strict and no invalid attempt is staged or applied.

Apply compares document identity, active version, storage path, byte hash, text
revision, and extracted-text hash. Same-ID editor saves invalidate proposals. Stable
proposal/version IDs make retries idempotent; concurrent proposals have one winner.
A manual brief edit does not inherit an accepted-review stamp. Pending, failed,
empty or incomplete extraction remains outstanding; selection is not review.
Historical quotes/fingerprints are retained, but historical source bytes are not
promised where the normal editor replaces them in place.

Non-goals: autonomous legal assessment, background inbox scanning, sending email,
calendar/tasks, verified deadline calculation, global matter resolution, generic
memory replacement, or a Matter OS. This prototype requires an existing DOCX brief.
Adapter mechanics use fictional fixtures; separate live-provider qualification also
uses entirely fictional sources. Neither substitutes for legal review or establishes
a general improvement in model reasoning over ordinary project chat.

In the final small matched Sonnet 5.5 comparison, independent AI-agent review
scored ordinary Mike 100/100 twice and the feature 97/100 and 100/100. The 97-point
draft was held unapplied because a proposed causation statement needed correction;
only the adequate 100-point feature draft was used for the explicit Apply test.
This was AI-agent review, not a lawyer's legal approval. It supports a limited
internal review prototype, not a claim of superior reasoning or general reliability.
