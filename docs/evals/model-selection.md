# Model selection and performance protocol

Choose a model/configuration per workflow from acceptable quality candidates,
then improve latency and cost within that constraint. A fast incorrect review
or an answer whose download fails is an unsuccessful task. The initial seeds
and offline smoke results do not qualify any model. This is a proposed operating
protocol; targets need legal, product and platform owners before execution.

## Freeze the experiment before looking at results

Write an experiment manifest containing the decision, incumbent configuration,
candidate configurations, workflow/risk slices, independent matter population,
trial count, budget, comparison axis and acceptance policy. Include an
experiment owner and reviewer, corpus/source hashes and an analysis freeze date.

| Control | Required record |
| --- | --- |
| Candidate | Resolved provider/route and model snapshot, requested model, fallback, decoding, reasoning, context/output limits, delegated model identities |
| Product | Product commit, system/user/workflow prompt hashes, user-copy content, playbook snapshot, catalog commit and assets |
| Tools/data | Tool schema versions, retrieval/index/OCR settings, source/version hashes, actor/permissions, connector fixtures, Word host/version |
| Execution | One immutable policy covering deadline, internal/whole-task retries, concurrency, cache state, region, service/image versions, hardware and network regime |
| Grading | Rubric/code version, judge identity/prompt/settings and calibration study, human reviewer assignment and adjudication protocol |
| Analysis | Primary quality endpoint, critical rules, minimum meaningful margin, sample-size/power or precision calculation, missing-data policy, secondary metrics and multiplicity policy |

Compare the incumbent with a small, justified set of candidates on identical
cases and planned repeated trials. Schedule paired trials in randomized or
interleaved order to avoid time-of-day/load effects. Equal scheduling seeds
identify pairs; they do not guarantee identical model randomness. Fix tool
permissions and budgets; a silent model fallback creates a different candidate.

Use `--axis model` only with the same execution environment/prompt/retrieval
and policy. Provider and reasoning/decoding settings remain disclosed parts of
the candidate configuration. If tuning the prompt, routing, retrieval or product
alongside the model, use `--axis system`, describe the changed components and
run ablations before attributing the gain. Keep the grader fixed or regrade all
stored answers after calibration changes.

## Quality comes from workflow-specific outcomes

The [workflow matrix](workflows.md) is the complete family-level starting point.
Implement richer scorers against reviewed truth before setting acceptance gates:

| Task | Primary quality measurements | Failure that must remain visible |
| --- | --- | --- |
| Grounded Q&A/research | Atomic claim correctness/support, material claim citation coverage, useful abstention, authority/date/jurisdiction | Unsupported material claim or fabricated authority; valid URL syntax alone is insufficient |
| Retrieval | Gold supporting-span recall@k, irrelevant-context load, revision/scope correctness | Correct answer guessed without retrieved support; incomplete text mistaken for absence |
| Review/proofread/playbooks | Material issue recall, issue precision, rule/exception fidelity, unnecessary/harmful edits | Flagging every clause to game recall; material issue missed or economic meaning changed |
| Extraction/tabular | Typed field/cell accuracy, precision/recall where applicable, correct null/unknown, support and row isolation | Wrong currency/unit/date, one row's evidence applied to another, failed cells omitted |
| Drafting/editing/comparison | Required facts/constraints, material-change recall, fact invention, version/anchor fidelity and readable final artifact | Mutated source template, invented missing fact, wrong edit occurrence, reversed comparison |
| Agent/tool workflows | Whole-task outcome, scope/approval compliance, correct synthesis, truthful partial status and side effects | Plausible parent answer conceals child error, unauthorized action, duplicate replay |

Report both diagnostic partial credit and binary task success. Define material
issues and acceptable alternatives case by case. Critical authority, harmful
legal error, cross-matter disclosure and required-artifact failures cannot be
offset by style or other easy cases. The offline runner currently implements
narrow structured assertions and binary rubric verdicts; recall/precision,
claim decomposition, document diffs and artifact parsers require separate
reviewed adapters/graders. Do not infer those metrics from the starter checks.

## Decision policy to approve before the run

| Gate | Proposed rule to operationalize | Evidence needed |
| --- | --- | --- |
| Corpus/grader eligibility | Approved cases, supported adapters, calibrated graders and sealed acceptance matter families | Review/calibration records, complete coverage ledger, access audit |
| Critical failures | Any observed critical failure blocks promotion pending remediation; zero observed failures is not proof of an acceptably small rate | Failure adjudication plus a risk-based upper confidence bound/sample plan |
| Quality | Meet owner-approved absolute floors **and** noninferiority to incumbent for every required workflow/high-risk slice | Predeclared margin, paired uncertainty and sufficient independent matters |
| Reliability | Meet completion, all-trials consistency, retry and timeout limits | All scheduled attempts; no best-of-many substitution |
| Performance | Meet per-workflow p50/p95 time-to-usable-result and spend limits among quality-eligible configurations | Controlled measured workload and complete billing/telemetry |
| Human review | Resolve material disagreements, check unsupported claims/edits and approve deployment scope | Qualified legal reviewer and product/platform owners |

There are deliberately no universal pass percentages, latency numbers or
cost floors here. Set them from risk, current baselines and the intended user
decision before testing candidates. A missing threshold, owner, sample plan,
review or measurement makes the decision incomplete. Proposed planning budgets
in workflows.md are staffing estimates, not statistically powered gates.

Use matter/source lineages as independent clusters. Multiple variants, document
questions, cells and repeated trials from one matter do not become independent
samples. The offline comparison provides a matter-cluster percentile bootstrap
for case/trial-weighted pass differences and mean resource differences. It does
not implement noninferiority testing, multiplicity correction, rare-failure
upper bounds or a full power analysis. A degenerate bootstrap interval after
zero failures is particularly unsuitable as rare-risk assurance.

For multiple candidates or many slices, predeclare primary endpoints and an
appropriate multiplicity/confirmation plan. Use a fresh confirmation cohort
after exploratory selection. Withhold a ranking when judge error or uncertainty
is comparable to the model margin. Keep ties/inconclusive results visible;
do not choose by point estimate alone.

## Performance measurement and diagnosis

Measure what a user waits for: from submission through queueing, retrieval,
model/tool/delegate calls and rendering/persistence to a usable final artifact.
Measure first useful visible output separately from final completion; token
streaming can look fast while a document remains unavailable. Capture cold and
warm cache runs as separate strata, with document count/format/size/token length,
requested output, concurrency, provider region, retries and timeout policy.

Record candidate tokens, tools and billed cost across parent, all children and
failed retries; evaluator/judge/generator costs belong in a separate ledger.
Calculate total cost per successful user task only when total spend is known
and task quality is resolved. Unknown pricing/usage is unknown cost. Include
failed attempts in latency/spend summaries and report timeout censoring. Do not
compare a successful-only candidate median against an all-attempt incumbent.

For a live load experiment, freeze the synthetic workload mix and arrival
pattern, ramp concurrency in controlled steps, and record throughput, queue
depth, error/timeout rates and p50/p95 end-to-end times with sample sizes.
Isolate load trials from legal-quality trials so contention does not masquerade
as model ability. No load runner or production SLO is established by this PR.

Use trace-stage attribution to choose the next experiment:

| Observed bottleneck/failure | Next controlled experiment |
| --- | --- |
| Evidence absent before generation | Retrieval/index/OCR ablation with fixed model and gold evidence recall |
| Correct evidence but unsupported answer | Prompt/model/reasoning comparison with frozen source packet |
| Excess tool/delegate calls | Direct vs delegated outcome comparison; compare aggregate spend and usable-result time |
| Slow first useful output | Provider/queue/tool-start timing; separate cold connection and retrieval effects |
| Fast answer, late/broken artifact | Persistence, rendition, download and export regression checks |
| High rework or retries | Structured output/tool error taxonomy, repair policy and idempotency tests |
| Better average but worse high-risk slice | Slice-level adjudication; restrict routing or retain incumbent for that workflow |

Report the quality/latency/cost Pareto frontier for eligible configurations.
Routing different workflows to different models is a hypothesis to test; it
adds routing/fallback and subagent configurations to the end-to-end suite.
Promote one controlled change at a time with rollback criteria, then sample
permitted production outcomes for distribution shift and sanitized regression
cases. A small synthetic benchmark win alone is not a rollout decision.
