# Generating and maintaining trustworthy evaluation cases

A generated case becomes useful only after its task, evidence and grading rules
have been checked independently. The committed seed set is public development
data with unreviewed synthetic provenance. It illustrates contracts and failure
modes; it is not lawyer-approved gold, a sealed holdout or a production success
measurement. [Workflow coverage](workflows.md) identifies the major surfaces;
[architecture](architecture.md) identifies who may generate, execute and judge.
The [research notes](research.md) link the primary evidence behind this design;
the operational rules below are proposed Mike engineering policy.

## Define the decision before generating examples

For each workflow, write the user outcome, evaluation unit, risk slices and
acceptance rule first. A tabular review may need cell-level extraction accuracy
and whole-table completion; a contract review needs material issue recall and
false-positive burden; a document edit needs accepted/rejected content and an
openable artifact. Model selection needs matched whole-product runs, not a
standalone prompt resembling only part of the workflow.

Record the eligible traffic distribution and intended jurisdiction, language,
document length, format, matter type, actor role and tools. Keep a balanced
capability corpus for debugging and a separately weighted representative corpus
for deployment decisions. Never imply that two cases per family establish
coverage of all templates or real customer usage.

## Admission pipeline

1. **Acquire an approved source packet.** Start with synthetic documents,
   appropriately licensed public material or explicitly permitted/redacted
   production examples. Mining a user trace requires an appropriate consent,
   access and retention basis. Preserve provenance and deletion lineage; replace
   names consistently without breaking dates, arithmetic, cross-references or
   the actual failure. Do not publish a real client matter in the repository.
2. **Create grounded task specifications.** Keep source document IDs, version
   hashes and stable text offsets/span IDs. For legal research record
   jurisdiction, court/authority, effective date, retrieval date and any
   supersession or conflicting authority. Fixture law can be invented if
   explicitly marked as fictional and closed-world. Never pass synthetic legal
   propositions off as actual law.
3. **Ask a generator for proposals.** Supply the workflow's objective and a
   specific diversity brief, not a request for many paraphrases. Require a
   solvable task, expected observable outcomes, supporting spans, known
   ambiguities, adversarial variants, rubric and provenance. Keep generator
   model/prompt/version and source dependencies. The generator does not approve
   its own reference answer, judge candidate output or alter sealed cases.
4. **Apply automated hygiene.** Parse schemas; require unique IDs, known workflow
   IDs, nonempty assertions/rubrics, valid source references and no secrets.
   Check that expected values follow the packet, units/dates agree and negative
   fixtures are actually negative. A passing schema is not a legal review.
5. **Review independently.** A domain reviewer solves the task from sources
   before seeing the generated reference where practical. Verify legal status,
   material issues, acceptable alternate answers, unsupported claims, missing
   information and every critical rule. Correct the rubric or reject ambiguous
   tasks. For material legal cases require a qualified legal reviewer; a second
   model can critique but cannot replace that judgment.
6. **Split by matter/source lineage.** Assign all documents, amendments,
   translations, paraphrases and generated variants from one matter/source
   family to one split before prompt optimization. Deduplicate exact hashes and
   near-duplicate text; inspect semantic neighbors and shared answer spans.
   Record the split assignment and review. Do not randomly split rows from the
   same document between development and acceptance sets.
7. **Calibrate graders before evaluating candidates.** Build an independent
   human-labeled calibration set containing correct, plausible-but-wrong,
   partially correct and adversarial answers. Lock source/rubric versions and
   use the procedure below. Correct grader defects before promoting its result
   to a gate.
8. **Freeze and run.** Hash suite, sources and rubric; predeclare candidates,
   trial count, retry policy, metrics, critical failures and decision rule. Keep
   a sealed acceptance set inaccessible to case generators, candidate prompts,
   optimization loops and ordinary development reports. Anyone who repeatedly
   tunes against revealed acceptance failures has turned that set into dev
   data; replenish it before another acceptance decision.
9. **Promote real regressions.** After a product failure is understood, add a
   sanitized minimal case to dev/regression with its original failure category
   and evidence. Add distinct unseen matter variants to a future acceptance
   set through the review pipeline. Preserve old results and explain any gold
   change rather than rewriting history.

The seed schema's `provenance.review_status` and `split` must describe what
actually happened. Changing `unreviewed` to `approved` requires recorded human
review evidence, not a CI-generated flag. The registry should eventually retain
reviewer identity/qualification, review date, source/license lineage,
`as_of_date`, rubric revision and approved split. This PR does not create that
private review system.

## Generate hard cases that diagnose a failure

| Axis | Useful variants | Grade against |
| --- | --- | --- |
| Evidence availability | Missing clause, truncated exhibit, unreadable/corrupt upload, contradictory amendment, superseded version | Correct abstention/question or stated conflict; no invented fact; truthful ingest status |
| Legal task | Wrong party/defined term, exception buried elsewhere, unfavorable but permitted term, materially irrelevant issue | Material issue precision/recall and acceptable alternatives defined by reviewer |
| Retrieval and citations | Long distractors, same terms in unrelated clauses, cross-page quote, table/sheet evidence, wrong-version citation | Relevant evidence recall separately from answer correctness, quote existence, claim support and pinpoint coverage |
| Editing/artifacts | Reject one edit, accept others, tracked change overlap, rerun, missing rendition, download after finalization | Intended final text/version plus readable DOCX/PDF/XLSX and preserved required citations |
| Scope/authority | Viewer, excluded document, another project/workspace, revoked access, connector approve/reject/unknown outcome | Zero unauthorized read/write and accurate user-visible state |
| Injection | Document/email/web page or child brief asks to reveal secrets, skip grading, change task or send data | Stay within trusted task and permissions; capture action attempts as well as final text |
| Agent coordination | Independent subtasks, conflicting briefs, missing parent fact, duplicate/overlapping edits, child timeout | Whole-task quality, verified synthesis, correct pauses and no duplicated actions |
| Reliability/performance | Streaming interruption, retry, provider refusal, long document, cold/warm cache, concurrency levels | Explicit terminal state and all-attempt latency/token/cost; no silent denominator reduction |

Vary one factor at a time for diagnostic counterfactual pairs, then include
realistic combinations in acceptance cases. Keep paired variants in the same
split and resample at matter level for uncertainty. Adversarial sets should be
reported separately from representative traffic; neither distribution should
silently replace the other.

## Judge calibration and rubric design

Use deterministic checks for exact values, authorization, artifact existence,
quote location and side effects. Use human judgment or a calibrated model judge
for legal materiality, sufficiency, faithful synthesis and usefulness. A
reference answer is evidence, not the only acceptable wording. A judge should
score one criterion at a time with explicit anchors and identify supporting
source/output spans. Require a short evidence-based rationale and uncertainty;
private chain-of-thought is neither required nor a grading artifact.

A workable anchor for **material issue coverage** is: fail if the answer omits a
reviewer-marked material issue or asserts the contrary; partial if it identifies
the issue but misses a material exception/remedy; pass if it states the issue,
its supporting provision and relevant exception/action accurately. Mark exact
material issues on each case. Do not use this broad anchor as a substitute for
case-specific gold. **False-positive burden** must separately penalize invented
or immaterial issues so a long checklist cannot game recall.

Before enabling a model judge:

- Have independent domain reviewers label a stratified calibration set, then
  adjudicate disagreements and document residual ambiguity. Report per-rubric
  confusion matrices, false-pass/false-fail rates, agreement and uncertainty;
  raw agreement can hide imbalance when almost every answer passes.
- Blind candidate identity, provider, latency/cost and prior score. Randomize
  pair order; repeat in swapped order and measure position sensitivity. Include
  concise correct/verbose incorrect pairs and injection attempts. Keep judge
  settings and source access fixed across candidates.
- Test judge-model family preference and answer-length effects. Where practical
  use a judge independent from the generator/candidate, but do not assume a
  different provider guarantees independence. Recalibrate on the actual tasks.
- Route critical disagreements, novel failure types and low confidence to a
  human. If judge error is material to the proposed model margin, the automatic
  ranking is inconclusive. A target agreement threshold requires the legal
  owner's risk decision and confidence interval; it is not a universal constant.
- Version judge prompt/model, anchors and rubric. Regrade stored answers when a
  grader changes, and keep candidate execution fixed to distinguish grader
  drift from product improvements. Keep calibration examples out of acceptance
  performance estimates.

## Grow the suite without rewarding contamination

Use separate dev, grader-calibration and sealed acceptance matter families.
Public seed cases and public legal benchmarks are useful capability probes,
but training exposure cannot be ruled out. Record benchmark versions/licensing
and disclose contamination risk; do not use a public leaderboard score as the
sole model decision for Mike. Generate fresh tasks from held-back source
families and test paraphrase/format/ordering robustness without copying gold
into candidate context.

Track corpus counts by workflow and risk slice, not just total examples.
Review every production incident and periodic sampled traces for new cases,
then revise the distribution intentionally. Proposed starting expansion targets
and staffing belong in the model-selection plan and should be adjusted after
pilot error rates, reviewer throughput and confidence intervals are known.
The final acceptance set size must support the actual decision margin and
critical failure tolerance; no small synthetic starter set can provide that.
