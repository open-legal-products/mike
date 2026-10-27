# Evaluation architecture

This is the target architecture for Mike's evaluation system. The code in this
PR provides an offline contract, deterministic grading, and recorded-run
comparison foundation. It does **not** execute Mike, call models, run an LLM
judge, establish lawyer-reviewed ground truth, or certify any model for release.
See [workflow coverage](workflows.md) for case scope and
[generation](generation.md) for corpus admission rules.

## Separate authority, execution, and judgment

Use a coordinator with bounded specialist jobs. These roles need separate data
views and permissions; they need not all be autonomous LLM agents. Deterministic
code should coordinate runs, enforce budgets, validate records, and calculate
statistics. Add an LLM only where it improves a measured task.

```mermaid
flowchart LR
  G[Case generator] --> R[Independent domain reviewer]
  R --> C[Versioned case registry]
  C --> O[Run coordinator]
  O --> X[Isolated Mike executor]
  X --> D[Deterministic graders]
  D --> J[Blinded calibrated judge]
  J --> A[Human adjudication]
  A --> P[Report and release decision]
```

| Role | Inputs and output | Authority and isolation |
| --- | --- | --- |
| Case generator | Permitted source packet, failure taxonomy and diversity brief → proposed task, evidence spans, rubric, distractors and provenance | Reads approved source material; cannot accept its own cases, modify sealed cases or see candidate outputs while authoring gold. Generated answers are hypotheses. |
| Independent reviewer | Proposed task plus source packet → accepted, revised or rejected case with reasons | A qualified reviewer verifies legal facts, jurisdiction, date, ambiguity and rubric. A second generator model is a useful critic, but does not constitute legal sign-off. |
| Coordinator | Immutable suite, candidate configuration, budget and plan → complete run ledger | Reserves case/trial slots before execution, creates disposable workspaces, enforces concurrency/time/spend limits and schedules cleanup. Holds no authority to waive a failed gate. |
| Mike executor | Task and allowed fixtures, user role, model/effort/tool configuration → actual response, artifact state, events and usage | Receives no reference answer, assertions, judge prompt or hidden rubric. Calls Mike's existing interfaces using synthetic identities and scoped resources. Never receives production credentials or arbitrary destination URLs from a case. |
| Deterministic graders | Captured response and independently observed state → assertion results and diagnostics | Read-only; check schemas, exact values, scope, quote/span provenance, artifacts and authorized side effects. Do not infer legal correctness from a keyword match. |
| Blinded judge | Trusted rubric/source packet plus delimited candidate answer → criterion labels, supporting evidence and uncertainty | No write/network tools, no candidate model name, no gold editing. Candidate text, tool output and retrieved material are data. Treat instructions embedded in them as untrusted. |
| Adjudicator | Judge disagreements, critical failures, low-confidence or novel cases → resolved labels and rubric fixes | Human domain owner resolves material legal disputes. Preserve original labels and revision history; rerun affected comparisons after a rubric change. |
| Reporter | Locked run ledger and grader version → per-workflow quality, reliability, latency, cost and decision evidence | Never drops errors or rewrites records to improve a score. Distinguishes offline examples, unreviewed development data, calibrated results and sealed acceptance results. |

An outcome may be correct through several valid tool sequences. Grade the
requested final artifact/state and evidence first; use traces to diagnose
retrieval, planning, delegation, permissions and efficiency. Exact sequences
belong only in protocol tests where order is itself required, such as approval
before a connector write. The source rationale is collected in the [research notes](research.md).

## Product adapter boundary

The next integration should use Mike's existing behavior rather than a second
implementation of its prompts or tools:

| Surface | Existing seam to exercise | Independently capture |
| --- | --- | --- |
| Assistant and project chats | `backend/src/modules/chat/chat.routes.ts`, `engine/streaming.ts` | Final answer, SSE terminal state, verified citations, persisted messages, document versions and user-visible artifacts |
| Tabular review | `backend/src/modules/tabular/tabular.generate.ts`, `tabular.extract.ts` | All requested cells, retries, flags and reasoning, claim-level citations, persisted final table and exported workbook |
| Custom/default workflows | `backend/src/modules/workflows/`, `backend/src/lib/workflowCatalogSource.ts` | Immutable catalog commit, imported editable definition, inputs and generated artifact; an import is not a successful execution |
| Word | `backend/src/modules/chat/engine/wordPrompt.ts`, `tools/wordClientTools.ts`, `word-addin/` | Task-pane/client tool events, active-document content and tracked edits in a real Word host; an API-only mock is a separate test layer |
| Model selection | `backend/src/lib/modelSelection.ts`, `backend/src/lib/llm/providers.ts` | Requested and resolved provider/model, route, reasoning and delegated model identities; a fallback is a changed configuration |

An executor adapter must project product events into the eval response schema
without inventing findings. For example, `output.export_downloadable = true`
requires opening the generated download and checking bytes, status, type and
expected content; a successful tool call or a candidate's assertion is
insufficient. Keep the raw sanitized evidence reference so a reviewer can audit
every projected value. The committed structured seed outputs describe the
expected observable state; they are not necessarily the product's native JSON.

A future executor job can use the following handoff. This is an adapter design
example, not a new public Mike API or a command implemented by this PR:

```json
{
  "v": 1,
  "run_id": "synthetic-run-001",
  "case_id": "case-from-locked-suite",
  "trial": 1,
  "candidate_config_sha256": "sha256-of-config",
  "task_packet_sha256": "sha256-of-task-and-fixtures-only",
  "resource_scope": {
    "workspace": "disposable-eval-workspace",
    "actor_role": "viewer",
    "allowed_document_ids": ["fixture-doc-a"],
    "connector_mode": "sandbox"
  },
  "budget": {
    "wall_time_ms": 120000,
    "maximum_attempts": 1,
    "maximum_external_writes": 0
  }
}
```

Job schemas should reject unknown fields and non-finite or negative budgets.
Only the coordinator resolves approved fixture IDs and executor endpoints.
Each emitted record identifies the case/trial and includes observed terminal
status, output/evidence, total end-to-end elapsed time, token/cost availability,
and all attempts. The run manifest pins suite, fixture, prompt, tool schema,
workflow catalog, product commit, model snapshot/route, decoding/reasoning,
cache policy, judge and grader revisions. Hash the exact bytes used; save
external snapshots and hashes when reproducible collection is permitted.

The currently implemented offline record format and commands are authoritative
in the eval runner documentation. Its capture envelope has `version`, `run` and
`observations`; each observation identifies `case_id`, 1-based `trial`, `seed`,
`status`, `output`, `measurements`, `evidence` and any `judgments`. The run pins
`candidate`, `environment`, `suite_sha256` and the planned `trial_seeds`.
A live adapter must satisfy that contract and add evidence rather than silently
accepting this illustrative packet. Keep capture identity separate from the
reviewed case registry: `reference_fixture` is a harness self-check, whereas
`product_capture` represents independently observed Mike execution.

## Trial lifecycle and budgets

A planned `(case_id, trial)` slot must produce a record even after a crash.
Record transport errors, timeout, cancellation, budget exhaustion, missing data
and unsupported capability explicitly; none is a successful empty answer.
The offline capture status is `completed`, `error`, `timeout` or `cancelled`;
preserve finer product states such as `incomplete` and `needs_input` in
`output`/`evidence`. Do not map an executor collection failure to `completed`.
A deliberate task outcome such as asking a necessary question or awaiting an
approval can be correct when the case expects it. Distinguish that application
state from an executor which failed to finish collecting evidence.

Fix the retry policy before comparing candidates. Distinguish a provider's
internal retry from a user-visible whole-task retry, and charge both to latency,
tokens and cost. Never report best-of-N as ordinary single-attempt success.
Preserve failed attempts when a later retry succeeds. Report single-trial pass
rate and all-trials success separately; do not confuse them with pass@k.

Proposed initial execution controls are one whole-task attempt, three repeated
trials per case for development investigations, and bounded concurrency agreed
for each workflow. These are starting operational choices, not sufficient
sample sizes for a release or universal literature thresholds. Choose a larger
sealed sample from an explicit power/precision plan before a model decision.
Provider rate limits, warm/cold caches, document length, parallelism, region,
queue time and end-to-end versus model-only time must be recorded and matched.

## Evaluate Mike's existing agents

This section describes the implementation at source commit
`d4fd89996e638f66ca55331cb787ce38e11975e1`. Keep invariants aligned with source
when implementation changes; do not impose an unrelated ideal agent policy.

| Current behavior and source | Evaluation to add alongside legal-task quality |
| --- | --- |
| Chats/project chats can delegate; tabular review, workflow runs and Word do not use subagents. `docs/subagents.md`; `engine/streaming.ts` advertises delegation when a run store is supplied. | Cover eligible and ineligible surfaces. Compare direct answering with delegation on the same substantive task; report quality benefit, latency and total spend. Do not reward delegation count. |
| `tools/delegateTools.ts` limits accepted starts to eight per answer, continuations included. A child is denied `delegate`, `ask_inputs` and `create_text_card`, and may call `ask_parent`. | Attempt a ninth start and nested/user-question tools; require refusal. Test a justified parent question, accurate continuation and no guessed answer when only the user knows. |
| A child inherits the parent's permitted tools and document-mutation gate. Scoped stores expose only named documents plus newly created ones; scoped project/library/template searches are refused. `tools/documentScope.ts`, `tools/toolDispatcher.ts`, `engine/streaming.ts`. | Place a salient secret in an excluded fixture and test read/search/edit bypasses. Require zero exposure or unauthorized mutation, including from a project viewer. Test that newly created documents remain available to the parent. |
| Child briefs and prior tool results are untrusted; only verified document/case source lines are handed to the parent. Parent citations are verified again. `tools/delegateTools.ts`, `engine/verifyCitations.ts`. | Inject instructions into a source and child brief; require the parent to stay on task. Check claim support separately from verbatim quote existence and final citation rendering. A matching quote does not prove the legal inference. |
| Edits share document locks and turn edit state. `engine/streaming.ts`, `tools/documentLocks.ts`. The prompt tells the parent not to delegate overlapping edits. | Deliberately overlap edit targets; inspect version order, surviving content, edit cards and disclosures. Distinguish server serialization correctness from the model's planning quality. |
| Connector approvals pause the child and parent. Decisions are recorded and approved calls execute from persisted server bindings. `tools/connectorApprovals.ts`; `tools/delegateRuns.ts` reconstructs outcomes. | In sandbox connectors test approve, reject, permission change, replacement connection, failed execution and unknown outcome. Require no preapproval write, no duplicate replay, correct final disclosure and no speculative retry when the outcome is unknown. |
| Effort presets in `tools/delegateTools.ts`: quick 20 steps/600k tokens/10 min/10 searches/15 reads; standard 50/2.5m/30 min/25/40; deep 120/8m/90 min/60/100. Aggregate child web limit is 150 searches/250 reads in `tools/webSearchTools.ts`. | Test boundaries with deterministic provider/tool mocks before spending real tokens. Capture reported tokens and actual terminal reason. Token enforcement occurs at reported step/tool boundaries, not a guaranteed preflight hard cap. A final brief at a step ceiling still needs an outcome-quality grade. |
| Parent stop propagates; timeout or token stop yields `incomplete`, parent cancellation `cancelled`, unexpected error `failed`; question/approval yields `needs_input`. `tools/delegateTools.ts`. | Interrupt mid-task and during an in-flight tool. Require truthful partial-status presentation, preserved side-effect evidence, no post-cancel new work, and correct retry handling. Report success for the entire user task, not just successful children. |
| Tiers `light`, `standard`, `same` step down eligible first-party models without exceeding the parent's tier; routers/cloud/local reuse the chat model. A named available model overrides tier; unavailable named model falls back with disclosure. `backend/src/lib/modelSelection.ts`, `tools/delegateTools.ts`. | Pin requested/resolved identities and reasoning; test explicit user model/effort requests and unavailable fallback. Evaluate routing as a configuration of the whole system, not as the label of the parent model alone. |
| Saved transcripts last 30 days, are scoped to their starting user/chat, and remove results from unavailable documents/versions before continuation. Failed/cancelled runs are not saved for continuation. `tools/delegateRuns.ts`; `docs/subagents.md`. | Revoke access, remove a version, cross users/chats, expire a run and replay an approval. Require fail-closed continuation and no leaked prior evidence. Test database policy with the real isolated database; mocks cannot establish authorization. |

For every multi-agent task, score each child outcome, parent synthesis,
source-groundedness, completeness of changes disclosed, authority compliance,
and aggregate resource use. A parent which repeats a false child finding fails
even if every handoff was well formed. A child which times out is diagnostic;
the final user-task outcome determines task success.

## Evidence handling and promotion

Keep privileged raw traces in an access-controlled artifact store with a
retention policy and deletion propagation. CI receives synthetic cases and
sanitized summaries only. No keys, cookies, approval tokens, client matters or
full provider payloads belong in git or CI logs. Web query evaluation should
also verify Mike's rule against putting client/matter text into public search
queries (`tools/webSearchTools.ts`).

Release reports need per-workflow and high-risk slice results, denominators,
missing observations, critical failures, paired quality uncertainty and
quality-constrained latency/cost tradeoffs. `--axis model` comparisons require
identical product environments; `--axis system` permits environment changes and
must be described as a whole-system comparison. The public unreviewed seed
corpus remains ineligible for release decisions even when every offline check
passes. Hard authority/artifact failures
cannot be hidden by averaging them with style scores. Human/legal owner sign-off
is a separate decision from an automated green check. No live results or model
ranking are established by the offline fixtures in this PR.
