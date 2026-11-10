# Playbooks

Mike playbooks convert a human-authored Word or PDF negotiation guide into
structured rules that can review contracts.

## Data model

A playbook contains rules, optionally organized into topics. Guidance that
applies throughout a playbook is written as a rule. Each rule contains:

- a concept to identify at clause or agreement scope;
- a required/optional setting;
- standard, fallback, and unacceptable positions;
- illustrative, preferred, verbatim, accepted, or unacceptable sample clauses;
- conditions, reviewer guidance, and escalation actions; and
- source references to the imported paragraph or Word table cell.

A playbook starts in one of two ways: compiled from a Word or PDF negotiation guide,
or written by hand in the editor. A hand-authored rule carries no source
references; the strict source check below applies to compiled imports only.

Changes save automatically. Reviews use the latest saved rules and retain a
content snapshot so later edits do not change an in-progress or historical
review. There is no publishing step or numbered playbook version.

## Browsing and editing

The Playbooks table shows each playbook on one line, with its access, creator,
document types, represented party, jurisdictions, rule count, and last update.
Use the header search to find a playbook by name
or description. Checkboxes select rows for bulk deletion; select a name to
open the editor.

The default **All** tab shows every playbook available in the current workspace.
Personal workspaces also have **My playbooks** and **Shared with me** tabs.
Organization workspaces also have **Private** and **Public** tabs.

### Access

Access works as it does for workflows. Open the people button (beside the
**⋯** menu in the header) to see who can open a playbook and, as an owner, to
change it. Each person has a role:

- **Viewer**: view the rules and sources and run reviews.
- **Editor**: also edit rules, details, and supplementary documents, and
  replace the playbook from a file.
- **Owner**: also share it, change its visibility, and delete it. The creator
  is always an owner.

A personal playbook is shared with existing accounts by email; recipients find
it under **Shared with me**. An organization's playbook is shared only with
its members. A **Public** one (set in its details) can be viewed and run by
every member; unlike a workflow, members do not get Editor by default, so
editing is granted person by person, and members can be put on a deny list.
The organization's owners own every public playbook. A **Private** one is
open only to the people it is shared with. Sharing sends no email
notification. Unlike projects and workflows, an organization's owners do not
take over a private playbook whose creator has left.

When a creator deletes their account, each of their public organization
playbooks passes to an owner of that organization (the successor that receives
the rest of their organization work), with its runs by other members and its
files. Their private and personal playbooks, the reviews and imports they ran,
and shares addressed to them are deleted with the account. The account export
in **Settings > Privacy & Data** includes the playbooks they created and can
still open, the reviews they ran on playbooks they can still open, the
supplementary documents' details, and their import records. An
organization's owners can delete all of its playbooks, public and private,
from the organization's **Privacy & Data** settings.

The editor has two flat glass panels: rules on the left, and the selected
rule's form on the right. The rules sidebar uses the IDE Explorer's compact
rows, with a small dot before each rule name. Opening a playbook selects its first rule.
The sidebar's **+** adds an ungrouped rule. To organize rules, choose
**Add topic** from **Rules actions**, then drag a rule onto that topic.
Existing imported topics remain available.
Drag a rule above or below another rule to reorder it, onto a topic to group
it, or onto the sidebar's header or empty space to ungroup it. Clicking a rule
opens it. Right-click a rule, or use its row's **…** menu, to duplicate it,
move it out of its topic, or delete it. Reordering rules and putting one into a
topic take dragging. The open rule's own **…** menu
offers only **Duplicate rule** and **Delete rule**. Each topic row's **…** menu
has **Add rule**, to create a rule in that topic, and **Remove topic (keep
rules)**.
Duplicating places an independent copy immediately
after the source rule in the same topic (or in the ungrouped list) and selects
it for editing. Right-click the sidebar to add a rule
or topic, or a topic to remove the group while keeping its rules. The same
menus open with Shift+F10 or the keyboard's context-menu key. Changes autosave.
Select a rule to edit its concept, scope, positions, and sample clauses. Drag
the divider to adjust the panel widths, or focus it and use the arrow keys.
The panels stack on narrow screens. A toolbar above them contains **Rules**,
**References**, and **Runs**, with a button on the right for the current view:
**New rule** adds and selects an ungrouped rule, **Upload** adds a reference
document, and **New run** opens the new-run form.
**Use** is in the page header: **Run playbook** opens the new-run form on
**Runs**, and **Use in assistant** saves pending edits and opens a new
assistant chat with the playbook attached, ready for documents. **Edit details** (**View details** for a
reader), in the header's actions menu or a table row's menu, opens a dialog for
the playbook name, represented party, document types, jurisdictions,
description, and, in an organization, Private or Public. The dialog saves when
**Update** is pressed, as other details dialogs do.

The header shows **Saving…**, **Saved**, or **Couldn’t save** in its own button
group. **Saved** disappears after two seconds, as in the workflow editor. Autosave accepts
unfinished fields; running a review requires complete rules. Pending changes
are saved before returning to the table, replacing from a file, or starting a
review. A failed save retains the current edits and offers a retry.

## Starting a playbook without a file

Open **Playbooks**, select **New playbook**, then **Start from scratch**. A
dialog asks for the playbook's name and, optionally, its represented party,
document types, jurisdictions, description, and, in an organization, Private
or Public. Mike then opens the new playbook on **Rules**. It starts with one
ungrouped rule and no topics. A rule always
needs a concept, so the first one carries placeholder text to replace.

## Importing a playbook

1. Open **Playbooks**, select **New playbook**, then **Import from file**.
2. Under **Add document**, drop a `.docx` or `.pdf` playbook, or click the
   area to choose a saved file or upload one. Choose a compilation model. Only
   models with usable credentials are offered, and Mike preselects an
   available one. Select **Compile**. The dialog shows that the playbook is
   compiling and opens it when it is ready. Long files can take several
   minutes; you can close the dialog or leave the page meanwhile.
3. Review the extracted topics, concepts, positions, sample clauses, and
   source references.
4. Refine the rules as needed; corrections save automatically.

A dropped file is uploaded straight to object storage under a presigned URL
scoped to the signed-in account, then the API compiles it from that key. The
API never receives the file body, and the staged object is removed once the
import has finished, whether it succeeded or failed. A saved file is read from where it is
stored, after the same access check as opening it; the playbook keeps its own
copy, so later edits to the saved file do not change the playbook.

The importer reads Word headings, paragraphs, and tables before asking the
model to compile the material. A PDF has no such markup, so each block of text
separated by a vertical gap becomes one cited paragraph, and a paragraph never
spans a page. A PDF without a text layer (a scan) is refused with a message
that it needs OCR. Mike automatically recompiles once when the first response
is not valid JSON, fails schema validation, or cannot be tied back to the
source. It retains the original file only after
compilation succeeds. Every imported rule must resolve to at least one real
source reference, or the import fails rather than creating an unauditable
rule. The parsed structure is transient; only the original file and the
compiled content with source references are retained, avoiding a duplicate
document copy in the database.

Each model attempt has five minutes by default. Set
`PLAYBOOK_COMPILATION_TIMEOUT_MS` to override that limit, or
`LLM_REQUEST_TIMEOUT_MS` to set a shared default. A playbook-specific value
takes precedence. The limit bounds how long an import waits; it does not abort
the model request already in flight.

`POST /playbooks/import` checks the file, the replace target, and the model,
records the import, queues a `playbook.import` job in `db_jobs`, and answers
`202` with the import record. A request that cannot be compiled is still
refused by that call; a file that turns out to be unreadable fails the import
when the job reads it. The
page follows the import by polling `GET /playbooks/imports/:importId`, and
`GET /playbooks/imports` lists the caller's imports still compiling in the
workspace, so a page opened later picks them up: the playbooks list shows each
as **Compiling …**, and a notice says when it is ready (with **Open**) or why
it failed. Imports and reviews run as durable jobs; see
[Background jobs](#background-jobs) below for how a restart is survived and
when one reads as "The import stopped before it finished."

Each import creates an audit record with its current processing stage. Failed
imports retain the stage and error without retaining the source document,
making credential, text extraction, model compilation, and output-validation
failures distinguishable. The same record is what the page reads to follow
an import.

## Replacing a playbook from a newer file

Open the playbook's actions menu, then **Replace from file**. The compiled
result rewrites that playbook's content and keeps its name unless you supply a
new one.

The playbook is read-only while the replacement compiles, even after you close
the dialog or reload the page, so an edit cannot overwrite the new rules or be
lost under them; editing resumes when the replacement finishes or fails.
The server enforces this for every client, including another tab or device:
while a replacement runs, saving the playbook's content returns 409 "This
playbook is being replaced. Wait for the import to finish." A replacement
also saves only over the version of the playbook it began from, so if the
playbook was saved after it began, the import fails with "The playbook was
edited while the replacement was compiling. Replace it again." and the edit
is kept.

A replacement rewrites the current rules. Completed and in-progress reviews
retain the rules they started with. The replaced file is removed once the
new content is stored, and the same rate limit and ownership checks apply as
for a first import.

## References

The **References** tab, beside **Rules** in the playbook toolbar, lists the
documents behind a playbook in one list and shows the selected one read-only
on the right. The list starts with the Word or PDF file the playbook was compiled
from, if any, followed by up to 20 supplementary `.docx` or `.pdf` documents
the rules can refer to, such as a data protection policy or a clause template.
An editor adds supplementary documents with **+** or **Upload** (upload a
file, or choose one from the library or a project) and removes them from each
document's menu; the imported file changes only through **Replace from
file**.

A supplementary document is a copy the playbook owns: anyone who can view the
playbook can open it, and later edits to the original do not change it. Its
text is extracted when it is added. Files are stored under
`playbooks/<creator>/<playbook>/sources/`. Database triggers queue durable file
cleanup on replacement or deletion, including account and organization
cascades; failed storage deletions are retried by the job worker. Account
deletion also sweeps `playbooks/<user>/` for files no remaining playbook
claims, such as staged uploads an interrupted import never read.

Reviews do not receive supplementary text by default. When a playbook has
supplementary documents, the review prompt lists their ids, names, and
lengths, and the model calls `read_supplementary_document` to read the ones a
rule, guidance, or instruction depends on, in pieces of up to 40,000
characters. The tool only reads documents belonging to the playbook under
review. A playbook without supplementary documents is reviewed in a single
model call, as before.

## Model selection

The compilation and review model menus draw on the same catalog as chat:
built-in cloud models, discovered Ollama models, and OpenRouter models when an
OpenRouter key is configured. A model is offered only when the account has a
usable key for its provider; organization playbooks use that workspace’s
effective provider keys. Local Ollama models need none.

## In the assistant

**Use in assistant**, or **Playbooks** in the composer's **+** menu, attaches
a playbook to the next message. The message carries it as `playbook: { id,
title }`, and the chat engine tells the model to review the attached document
with `run_playbook`, which checks access to the playbook again before it
reviews anything. The Word add-in's composer has the same **Playbooks** item
and pill. It lists the Personal playbooks the user can open, and
`POST /word-chat` answers 404 for a playbook the user cannot open, as `GET
/playbooks/:id` does. In Word, the review reads the open document's text, so
it saves no new version: the findings come back in the chat, and the user can
ask the assistant to make the suggested changes as Word edits.

## Contract review

Select **New run** on the **Runs** tab (in the toolbar or beside **Your
runs**), or **Use** then **Run playbook**. The form takes the main pane: drop PDF,
DOCX, or TXT contracts on the document area, or click it to choose saved files
or upload more, then choose:

- **Scope**: **Full review** checks every rule and lists what passed;
  **Issues only** reports only unacceptable, missing, and needs-review terms.
  It is quicker, but the run never lists what passed. The server holds the
  findings to the scope and records it on the run (`review_scope`).
- **Posture**: **Strict** flags clauses that only meet a fallback position for
  review; **Permissive** may accept them but says which fallback applied.
- **Review model**, and optional **Additional instructions**, empty by
  default: the review's own prompt already sets how it reviews.

**Cancel**, or choosing a run, returns to that run's results and keeps what
the form holds. Multiple files can be dropped into the document area; each
file gets its own review run.

Starting a review stores its run, queues a `playbook.review` job, and returns
at once, so leaving the page does not stop it. The run shows a spinner in
**Runs** and in the sidebar's History until it finishes. History polls
`GET /playbooks/runs/status?ids=` for running runs and pages through
`GET /playbooks/runs/history`. A running run cannot be deleted. Reviews the
assistant starts from chat wait for their findings, so they run inside the
chat turn instead of as jobs.

### Background jobs

Reviews and imports run on the durable job queue (`backend/src/lib/dbq/`), not
inside the request that started them, so a backend restart delays them
rather than losing them. The job carries what the row does not record (the
reviewed text and the document version edits are made against; for an
import, the staged key or saved document and the ids it saves under), and
reruns from the row: a review always uses the rules snapshot stored on its
run.

- **Restarts.** A job whose worker dies is claimed again once its lease goes
  stale (ten minutes) and runs the work from the start. A finished row is left
  alone, and results are written only while the row is still `running`, so two
  claims of one job cannot both record an outcome. A re-run's tracked changes
  are refused if an earlier run already revised the document.
- **Heartbeat.** While work runs, its row's `updated_at` is refreshed every 30
  seconds. A re-claimed job whose row is still being refreshed defers instead
  of running the model a second time beside a worker that is alive.
- **Interrupted.** A `running` row is reported as failed with "stopped before
  it finished" only when it has had no heartbeat for two minutes **and** no
  pending or running job in `db_jobs`. A job that exhausts its three attempts
  marks its row failed with the same message.
- **Failures.** A review or import that fails on its own terms (a model error,
  an unreadable file) is recorded on its row and not retried. Failures that
  are faults rather than refusals are also reported to Sentry under
  `component=playbooks`, by stage, with ids only (see
  [observability](observability.md#what-gets-reported)).
- **`DB_JOBS_ENABLED=false`.** With the runner off, the same handler runs in
  the API process after the response, as before jobs; the heartbeat alone
  keeps it from reading as interrupted, and a restart loses it.

Review findings include the rule, status, exact contract quote,
location, analysis, and suggested language. Each run is retained with the
exact content it was reviewed against.

Word reviews read the stored file and save suggestions as tracked changes when
the caller can edit it. If that file changes while the model is reviewing it,
the suggestions remain as text; rerun the review against the new version
before applying them.

A playbook's **Runs** tab lists your last 50 runs of it, newest first;
selecting one shows its settings, summary, and findings grouped by outcome,
with recommended language as a redline of the contract text. **Run details**
names the document, model, scope, posture, and start time. For a full review, a
toggle beside the **Findings** heading switches between **All findings** and
**Issues only**; this only hides what passed or did not apply, and keeps it on
the run. **View** opens the
reviewed document to the right of the results, where tracked changes can be
followed from their cards; it stays hidden until asked for. A run opens there
when it finishes. The **Runs** tab on the playbooks list shows your last 100
runs across every playbook you can still open in the workspace (`GET
/playbooks/runs`); choosing one opens it on its playbook. Its table filters by
playbook, outcome, scope, and posture, and each row has a checkbox, a **…**
menu, and the same menu on right-click: **Open**, **Open playbook**, and
**Delete**. Selected rows share the toolbar's **Actions** menu. Deleting a run
(`DELETE /playbooks/runs/:runId`) removes it and its findings; tracked changes
it made stay on the document, and a run still in progress cannot be deleted. Each person sees only
their own runs, including on a shared playbook, and the rules snapshot stored
with a run is never returned by either list.

The current one-pass safety limits are 150,000 extracted characters per
imported playbook, 100,000 serialized characters per playbook, and
180,000 characters per reviewed contract. Oversized inputs fail explicitly
instead of being silently truncated.

## Audit log

Playbook activity is recorded in the activity history (the **History** page,
an organization's audit page, and the audit CSV export) under the `playbooks`
surface, as chat, document, and tabular review activity is:

| Action | Recorded when |
| --- | --- |
| `playbook.created` | A playbook is started without a file. |
| `playbook.imported` | An import that creates a playbook ends; a failed one carries the `stage` it stopped at. |
| `playbook.replaced` | An import that replaces a playbook's content ends; a failed one carries its `stage`. |
| `playbook.deleted` | A playbook is deleted. |
| `playbook.run` | A review completes or fails. The row holds the model and the stored document reviewed, if any; `detail` holds the playbook and run ids, scope, posture, and, for a completed review, the number of findings per status. |
| `playbook.run.deleted` | A review run is deleted. |

Rows carry the playbook's name as their title and ids in `detail`, never
rule text, findings, or contract text. An import refused in the request that
asked for it (wrong file type, model unavailable) answers that request with
the reason and is not recorded. A review or import is recorded by the claim
of its job that wrote the outcome, so a job run again after a restart does
not record it twice; an import whose failure could not be written to its row
is retried and can, rarely, record a second row.
