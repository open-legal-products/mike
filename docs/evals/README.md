# Workflow evaluations for model and performance decisions

Mike needs three distinct kinds of evidence: a legal task was done correctly,
the product actually saved/delivered the intended result, and the resources
needed to do it. This guide defines that evidence across the current major
workflows. It is anchored to product commit
`d4fd89996e638f66ca55331cb787ce38e11975e1`; new product/catalog behavior requires
updated cases and integration coverage.

## What this change provides

- A source-linked registry of 22 workflow families and 44 synthetic development
  seeds, including a normal and negative/adversarial case per family.
- A dependency-free offline runner for definition validation, deterministic
  grading of recorded observations and paired quality/latency/cost comparisons.
- Regression tests for the evaluation machinery and a CI contract check.
- A design for independent case generation/review, isolated product execution,
  deterministic graders, calibrated blinded judges and human adjudication.

The seeds are public and unreviewed. They are specifications with reference
observations, including setup recipes for binary files, permissions and Word;
they are not product adapters or legal ground truth. No model tournament, live
execution, calibrated LLM judge, sealed corpus or production performance
measurement is supplied by this PR. Every report remains
`decision_eligible: false`: offline JSON validation cannot establish review,
judge calibration, capture integrity or holdout secrecy. A reviewer must verify
those separately before using results for a decision.

## Start here

Use Node.js 22 or later; no install or credentials are needed:

```bash
npm run eval:check
node evals/run.mjs validate
node evals/run.mjs smoke
```

`smoke` checks reference observations against deterministic assertions. Its
output explicitly states that no product, model or legal quality was evaluated.
It cannot be used in a model comparison. The harness tests include incorrect
values/citations, missing evidence, failed trials, judge drift, mismatched
execution policies and incomplete grading; matching a reference to itself is
not the only verification.

Once an independently implemented capture adapter has produced real records:

```bash
node evals/run.mjs score --responses /private/tmp/mike-baseline.json --out /private/tmp/mike-baseline-score.json
node evals/run.mjs compare --baseline /private/tmp/mike-baseline.json --candidate /private/tmp/mike-candidate.json --axis model --out /private/tmp/mike-comparison.json
```

These input files must satisfy the [capture contract](contracts.md); they are
not included measured runs. Output files are created exclusively with private
permissions, so an existing report is never silently overwritten. A nonzero
exit means invalid inputs or a harness error. A valid report can contain failed
tasks or inconclusive comparisons and still exit zero; this CLI is not a release
gate. Inspect status, assessment coverage, per-workflow scores and limitations.

## Guide and ownership

| Document | Purpose | Proposed accountable owner |
| --- | --- | --- |
| [Research](research.md) | Primary sources and decisions derived from them | Evaluation lead |
| [Workflow coverage](workflows.md) | Family outcomes, metrics, risks, catalog mapping and expansion | Workflow owners + legal reviewers |
| [Generation](generation.md) | Source-grounded authoring, review, calibration, splits and contamination | Legal/domain corpus owner |
| [Architecture](architecture.md) | Agent roles, authority, product seams and current Mike subagent invariants | Evaluation/platform engineering |
| [Contracts](contracts.md) | Implemented case, observation, grader and report semantics | Evaluation engineering |
| [Decision protocol](model-selection.md) | Fair model experiments, performance measurements and promotion evidence | Product + legal + platform owners |

## Implementation sequence

1. Review and correct seed tasks/rubrics with workflow and legal owners; choose
   the decision, representative traffic slices and risk tolerance in advance.
2. Implement versioned setup/readback adapters against the existing product
   seams. Start with core Q&A, proofreading, extraction, comparison, drafting,
   tabular review and the three audit regressions. Add real Word and sandbox
   connector hosts before claiming those surfaces executed.
3. Build separately reviewed grader-calibration matters and a restricted sealed
   holdout. Admit cases through the generation process; do not rename public
   seeds as acceptance data. Establish false-pass rates before trusting judges.
4. Capture the incumbent and candidate on the same cases, fixed execution
   policy, planned repeats and sources. Investigate critical failures before
   quality-constrained latency/cost decisions. Keep results by family and risk
   slice; a single leaderboard can hide important regressions.
5. Turn sanitized real failures into regression cases and replenish exposed
   acceptance matter families. Add model-backed scheduled runs only after
   credentials, budgets, data permissions and ownership are configured.

Software unit, database and browser tests remain necessary. Authorization,
transaction safety and Office host integration require their real test layers;
a model quality score cannot prove them.
