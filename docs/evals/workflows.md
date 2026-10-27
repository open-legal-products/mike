# Existing workflow coverage

This specification is anchored to Mike commit
`d4fd89996e638f66ca55331cb787ce38e11975e1`. The machine-readable registry is
[`evals/workflows.json`](../../evals/workflows.json); the initial corpus is
[`evals/cases/seed.jsonl`](../../evals/cases/seed.jsonl).

The registry defines **22 existing workflow families** and **44 authored synthetic
development cases** grouped into **22 synthetic matter lineages**, one ordinary
and one negative/adversarial case per family. Sibling cases within a family
share a matter ID conservatively; they must not be counted as independent
matters or assigned to different splits.
It is a coverage specification, not evidence that those workflows passed an
end-to-end run. Every seed is `synthetic`, `unreviewed`, and `dev`. No seed is a
sealed holdout or an approved legal answer. Reference outputs are grading
examples; scoring them demonstrates grader wiring, not Mike's quality.

The corpus concentrates on source-constrained tasks and observable product
outcomes. It does not establish that a model can give correct general legal
advice. Jurisdictional interpretation, materiality and drafting quality require
qualified review and additional representative matters.

## Capture semantics

A case's `input.documents` is a **provisioning inventory**, not a payload to send
wholesale to a candidate model. Its document text may include denied sources,
state recipes and environment metadata. Scope-sensitive records include an
explicit `setup`: `actor_role`, `candidate_document_ids`,
`denied_document_ids`, and (for delegation) `child_document_ids`, plus
`fixture_notes`. A versioned setup adapter provisions actual grants, bytes and
scopes, then builds each model packet using its typed document allowlist. It
must reject unknown or duplicate IDs and any overlap between parent-allowed and
parent-denied IDs. Do not infer access from prose annotations or forward the
full case, registry, reference output or grading rubric to the candidate.

For `scope-read`, A is candidate-allowed and B is denied. For
`scope-viewer-write`, only the actual A contract is candidate-allowed; the
`state` record is setup-only metadata. For `subagent-scoped`, A and B are allowed
to the parent, only A is allowed to the child, and no source is denied to the
parent. The child's packet and tool authorization must both use
`child_document_ids`; that list must be a subset of the parent's allowed IDs.
The parent receiving B does not authorize the child to see it. A malformed or
missing allowlist is a setup failure, never an invitation to supply the full
inventory. Input IDs such as `contract:s1` are fixture span IDs, not persistent
Mike database IDs. Create fresh actors, workspaces, projects and IDs per case
and map observations back to fixture IDs.

`reference_output` is the normalized observation shape. A capture adapter must
produce the same concepts from actual behavior, rather than prompt the candidate
to declare that it passed. In particular:

- Read document text and revisions back from stored artifacts or the real Word
  host. Derive edits, parseability and hashes from those bytes.
- Derive scope, permission, access and write fields from access-controlled
  datastore reads, context/tool traces and a recording connector fixture.
- Derive completion, duplicates, cancellation and approval outcomes from durable
  state and exact-content approval records, including all retries.
- Derive source spans and legal claims from the final response and verified
  sources. A model-generated citation string alone does not prove support.
- Keep raw trace/artifact references available for adjudication. A seed's
  equality check is a narrow regression probe; its rubric checks semantic
  correctness and unwanted effects beyond the asserted fields.

This PR defines the capture boundary. The seeds are not product adapters or
browser/Office automation. Every operational, binary, connector and Office
recipe requires a versioned setup **and** capture adapter. Before executing a
case, the pipeline must check those adapters declare support for its required
setup, state readback, document format, host and fault injection. Reject an
unsupported recipe before any model call and retain it as **unexecuted
coverage**, never as a passing case or an ordinary text-only approximation.
A missing host, connector, binary fixture or required adapter is not a skip that
may disappear from the coverage denominator. `.example.invalid` URLs and
email addresses, fictional court records and source-stated legal rules are
synthetic fixtures; no external account or real legal authority is implied.

## Workflow matrix

The final column is a proposed **additional** corpus budget per family:
development / judge calibration / sealed evaluation, after reviewing these two
seeds. It is a planning starting point, not a powered sample-size calculation or
a launch threshold. Choose final counts from expected variance, minimum
meaningful differences, traffic and risk; preserve matter-level independence.

| Family (`workflow_id`) | What must be measured | Important slices and critical failure | Capture surface | Additional D / C / H |
| --- | --- | --- | --- | --- |
| Q&A (`assistant_qa`) | Claim factuality, citation support and completeness, useful abstention | Multiple documents, conflicting clauses, unanswerable question; fabricated governing law | Chat response, verified source spans | 16 / 12 / 20 |
| Proofreading (`proofreading`) | Error recall and edit precision, legal/economic meaning preserved | Clean text, regional spelling, defined terms; unrequested substantive edit | Source and accepted-view DOCX diff | 12 / 10 / 16 |
| Key terms (`key_term_extraction`) | Typed field exactness, missingness, supporting spans | Currency/units/dates, cap vs insurance, exceptions; invented missing value | Final extraction + source | 16 / 12 / 20 |
| Compare (`document_comparison`) | Material-change recall, false positives, direction | Reordered clauses, layout-only, schedules, moved terms; reversed before/after | Two source versions + comparison | 12 / 10 / 16 |
| Template drafting (`template_drafting`) | Template fidelity, fact completeness, appropriate questions/placeholders | Skipped inputs, copy-before-edit, numbering; modified source template or invented fact | Saved new artifact and original hash | 16 / 12 / 20 |
| Playbook import (`playbook_import`) | Rule/condition coverage, standard/fallback/unacceptable positions, paragraph/table references | Tables, nested exceptions, unsupported sources; lost condition or instruction injection | Imported rules + guide paragraphs | 16 / 12 / 20 |
| Playbook review (`playbook_review`) | Per-rule precision/recall, materiality, recommendation and snapshot fidelity | Compliant clauses, absent required clauses, conflicting rules; harmful or noisy redline | Saved review snapshot, findings, tracked changes | 20 / 16 / 24 |
| Tabular setup (`tabular_setup`) | Column usefulness, schema/type validity, idempotent creation | All supported formats, large column sets, interrupted jobs; duplicates or conflicting formatting | Table/column records + generation state | 10 / 8 / 12 |
| Tabular extraction (`tabular_extraction`) | Per-cell exactness, format, reasoning/citation support, row isolation | Long rows, absent vs unknown, dates/tags/number/currency, follow-up; source from wrong row | Saved cells + reasoning + source | 20 / 16 / 24 |
| Ingestion (`document_ingestion`) | Valid-file fidelity, corrupt-file rejection, accurate readiness | PDF/DOCX/XLSX/PPTX, scans, empty files, malformed bytes; fake ready or silent extraction loss | Uploaded bytes, processing jobs, extraction | 12 / 8 / 16 |
| Document search (`document_search`) | Retrieval recall@k, current revision, authorization, honest coverage | Pending/OCR/failed text, old handles, literal punctuation, pagination; absence claim from incomplete corpus | Search results, context, text revisions | 16 / 10 / 20 |
| Edits (`document_edits`) | Anchor exactness, minimality, accept/reject, concurrency | Repeated phrases, tables, conflicting edits; wrong occurrence or rejected change survives | Actual document bytes + edit trail | 16 / 12 / 20 |
| Artifacts/exports (`artifact_export`) | DOCX/XLSX/PPTX integrity, download success, source and manifest preservation | Resolved tracked changes, unsupported rendition, legacy null hash; broken download or lost citation | Browser download, parsed artifact, manifest | 16 / 8 / 20 |
| Workflow catalog (`workflow_catalog`) | Correct selection, prompt/schema/assets, imported-copy independence | Defaults, add-ons, packs, custom copies, missing inputs; catalog/template mutation | Pinned catalog, user copies, actual execution | 16 / 10 / 20 |
| Projects/Library (`project_library_scope`) | Matter/workspace authorization, permitted read/write, template copies | Personal/org, viewer/editor/owner, archives, denied members; cross-matter leak or viewer mutation | Real authorization/context/readback | 16 / 8 / 20 |
| Web research (`web_research`) | Source relevance, body support, freshness, dates, search limitations | Frozen vs live sources, stale snippets, page failures; obeyed page injection | Fetched bodies, final citations, connector recorder | 16 / 12 / 20 |
| Legal research (`legal_research`) | Authority relevance, holding/limits, jurisdiction/date and pinpoints | Adverse authority, unpublished opinions, no results; fabricated case or misleading holding | CourtListener records/opinions + answer | 20 / 16 / 24 |
| Connectors (`connectors`) | Correct account/workspace, exact-content approval, idempotency, read-only policy | Drive picker scope, Gmail/Calendar, custom MCP, revoked access; unapproved send or changed-content replay | Recording service + approval records | 16 / 8 / 20 |
| Word (`word_addin`) | Real host edit fidelity, selection/anchor, approval and reconnect | Local/durable chats, host failure, repeated text; duplicate insertion or wrong selection | Real Word host + server/client trace | 12 / 10 / 16 |
| Memory (`scoped_memory`) | Useful retention, instruction precedence, scope, epoch/revision safety | Personal/org/project, shared audiences, wipe/disable, curator conflict; private leak or resurrection | Injected context, memory files, job epochs | 16 / 10 / 20 |
| Subagents (`subagents`) | Delegation value, scoped access, supported synthesis, partial work, whole-run cost | No delegation vs delegation, models/effort, continued child after access loss; child scope expansion or unverified authority | Parent/child traces + tool changes + source verification | 20 / 16 / 24 |
| Continuation (`continuation`) | Completion, pause/resume, cancellation, retries and side-effect count | Ask-input skips, stream loss, worker restart, provider timeout; duplicate mutation or work after cancel | Durable turn/job state + reconnect transcript | 16 / 8 / 20 |

The named source files for each family are entry points for choosing adapters and
regression tests, not a claim that these files alone implement every behavior.
Supporting account setup, org offboarding, model/credential preferences and
connector OAuth are product integration tests; include their failures in
end-to-end outcomes and keep deterministic authorization/database tests beside
this corpus. A model score cannot compensate for their failure.

## Catalog coverage and versioning

The prior local audit captured **169 catalog entries** (141 assistant, 28
 tabular) at workflow-repository commit
`20bed204ce9ef07e1bc2df0b16b35ee8ad997fb1`. That is a historical inventory, not the
current fetched catalog or a claim that 169 entries were executed. The runtime
source lives in the separate
[`mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository; Mike's ingestion job resolves its configured ref to an immutable
commit. Capture that commit, each workflow content hash and each user-copy
prompt/hash with every real run. Never bind a benchmark silently to mutable
`main` or a stale user copy.

The five defaults are selected in `backend/src/lib/workflowCatalogSource.ts`:

| Catalog key (without runtime `builtin-` prefix) | Required primary family | Additional required checks |
| --- | --- | --- |
| `proofread` | `proofreading` | `document_edits`, `artifact_export`, Word where exposed |
| `compare-documents` | `document_comparison` | Source version selection, output readability |
| `extract-key-terms` | `key_term_extraction` | `assistant_qa` citation and missing-value checks |
| `draft-from-template` | `template_drafting` | Source-copy integrity, `document_edits`, `artifact_export` |
| `commercial-agreement-tabular-review` | `tabular_extraction` | `tabular_setup`, cell citations and exported workbook |

For **every** current add-on/custom workflow, build a reviewed coverage ledger
with `workflow_key`, `workflow_content_hash`, `workflow_source_commit`, type,
practice, language, jurisdiction, primary family, secondary families, fixture
IDs, legal reviewer and execution status. The initial registry does not assign
or execute each of the 169 templates. A script that matches titles to a family
is only a suggested mapping; a maintainer must verify it against the actual
prompt, assets and table columns.

For assistant add-ons, select the primary family from the requested outcome
(review, extraction, drafting, research, comparison or Q&A) and retain every
material constraint in the workflow prompt. For tabular add-ons, bind the actual
`table-columns.yaml` columns to extraction rubrics and exact output formats.
Add template-specific tests for required questions, reference assets,
calculation/threshold rules, represented party and legal jurisdiction. Examples
written for English commercial contracts do not validate Finnish, German or
other jurisdiction/practice templates. Stratify language/jurisdiction separately
rather than averaging them into a generic assistant score.

A new/changed workflow is unqualified until its ledger has reviewed positive,
negative and exception cases, an executed smoke case, and the relevant sealed
slice. Catalog sync, import parsing and pack completeness remain separate
structural gates. Do not infer legal-quality coverage from successful ingestion.

## Case authoring and expansion

Each seed provides source facts, a task, narrow deterministic assertions and at
least one criterion for independent rubric review. The 44 seeds conservatively
share one matter ID per workflow family (22 matter lineages); fixture variations
and repeated trials increase observations, not the number of independent matters. Add minimally different
counterexamples: a compliant clause next to a breach, absent information next
to an explicit negative, scope denied next to scope allowed, failed extraction
next to true empty text. These expose false positives and false certainty.

Keep a development matter's originals, redlines, paraphrases, translations,
question variants and synthetic derivatives in the same split. Calibrate judges
on separately reviewed matters; hold sealed matters outside prompt-editing and
case-generation tools. A public seed renamed `test` is still development data.

The binary and Word cases are fixture recipes. Materialize valid PDF/DOCX/XLSX
bytes with versioned generators and verify their hashes; include malformed and
OCR-incomplete variants. Only a real Office host run qualifies a Word host case.
For live web/case-law tests, record the fetched body, timestamp, query, provider
and content hash; report these separately from reproducible frozen-source runs.
Recording connectors should never deliver messages or modify real client data.

The audit-regression seeds cover corrupt-PDF readiness, chat download after
tracked-change resolution, and spreadsheet citation loss. They describe desired
outcomes and may initially fail against current Mike. Fixing those defects is
separate product work; do not weaken the assertions to obtain a green eval run.
