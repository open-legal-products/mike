# Offline evaluation contracts

`evals/lib.mjs` is the executable contract. Version 1 intentionally uses only
Node built-ins and accepts recorded observations; it contains no provider SDK,
product executor or LLM judge. All committed seed cases are public development
data. Do not send a whole registry case to a candidate: it includes reference
answers, assertions, rubrics and potentially forbidden fixture documents.

## Case registry

`evals/workflows.json` declares the immutable product source commit and each
family's stable ID, entry-point source paths, metrics and risks.
`evals/cases/seed.jsonl` contains one case per line:

| Field | Meaning |
| --- | --- |
| `id`, `workflow_id`, `matter_id` | Stable case/family IDs; matter/source lineage is the statistical and split unit |
| `split` | `dev`, `calibration`, `holdout` or `regression`; public seeds remain `dev` |
| `provenance` | `kind`, `review_status`, notes; `approved` additionally requires `review_id` and `reviewer`. This is an evidence pointer, not automatic approval verification |
| `input` | Prompt and fixture-document inventory with stable source IDs and source text. It is a provisioning recipe, not automatically the candidate-visible packet |
| `setup` when present | Actor/access and provisioning requirements. An adapter must enforce the typed document allowlist before creating candidate context |
| `assertions` | `{kind, path, value, critical}` exact-value or narrow outcome probes |
| `rubric` | `{id, criterion, critical}` independently graded semantic criteria |
| `reference_output` | Normalized expected observation; never supplied to the candidate |
| `tags` | Risk/diagnostic slices, including normal and negative/adversarial coverage |

Assertion paths use dot notation starting with `output.`. `equals` compares
structured JSON values; `includes`/`excludes` operate on strings or array
members; `set_equals` requires the same unique array elements regardless of
order. Missing fields always fail an assertion, including `excludes`. A
correct quote ID or keyword does not establish claim support; that needs a
rubric judgment from source evidence. Assertion fields representing side
effects, permissions, artifacts or final state must come from independent
readback, never a candidate's self-report.

`validate` checks source paths, family coverage, IDs, split consistency for each
matter, reference/assertion consistency and contract fields. It does not prove
that references are legally correct, sources are licensed, matter IDs cover all
near duplicates, or access annotations have actually been enforced. The suite
hash binds the complete canonical manifest/cases, including source text,
setup, assertions and rubrics; editing any of them invalidates old captures.

## Recorded capture

The capture is a JSON object with `version: 1`, `run` and `observations`.
The following is a shape illustration, not measured model output:

```json
{
  "version": 1,
  "run": {
    "id": "unique-run-id",
    "kind": "product_capture",
    "suite_sha256": "hash-printed-by-validate",
    "candidate": {
      "id": "configuration-id",
      "provider": "resolved-provider-or-route",
      "model": "resolved-model-snapshot",
      "settings": {"temperature": 0, "reasoning": "record-effective-setting"}
    },
    "environment": {
      "product_commit": "immutable-product-commit",
      "catalog_commit": "immutable-workflow-catalog-commit",
      "prompt_version": "prompt-and-user-copy-hashes",
      "tools_version": "tool-schema-and-fixture-versions",
      "execution_policy_version": "hash-of-timeouts-retries-cache-concurrency-region-policy"
    },
    "trial_seeds": [42, 43, 44]
  },
  "observations": [
    {
      "case_id": "qa-supported",
      "trial": 1,
      "seed": 42,
      "status": "completed",
      "output": {"answer": "30 days written notice", "source_spans": ["contract:s1"]},
      "measurements": {
        "e2e_ms": 1000,
        "ttft_ms": 200,
        "provider_ms": 700,
        "queue_ms": 100,
        "input_tokens": 100,
        "output_tokens": 20,
        "cost_usd": null,
        "retries": 0,
        "tool_calls": 1
      },
      "evidence": {"trace_id": "restricted-sanitized-trace-reference"},
      "judgments": []
    }
  ]
}
```

Plan the entire case × `trial_seeds` grid before execution. `trial` is 1-based
and `seed` must match the plan. Seeds identify paired trial scheduling; providers
without deterministic seed support must record that in settings. Do not imply
that equal seeds synchronize different providers' random sampling. Duplicate
observations, unknown cases, wrong suite hashes and inconsistent seeds fail
validation. Missing planned observations are materialized as `missing` failures,
not removed from the denominator.

The observed terminal status is `completed`, `error`, `timeout` or `cancelled`.
An intentional product state such as awaiting approval/clarification can be a
completed observation if the case expects that state; an executor which failed
to collect the result is not completed. Record error/budget reasons and all
attempt evidence under `evidence`, plus artifact/hash and permitted side-effect
readback. The harness requires a trace ID but cannot verify its integrity.

Every observed attempt requires nonnegative `e2e_ms`, including errors/timeouts.
TTFT, provider/queue time, token and cost keys are required and accept `null`
for genuinely unavailable measurements. `retries` and `tool_calls` must be known
nonnegative integers; token counts are integers when available. Zero is a real
measurement, not missing data. Include internal retries and child calls in total latency,
tokens and candidate cost; retain per-attempt/stage records in trace evidence.
TTFT is first useful visible output; end-to-end ends at the usable persisted
result. Keep judge/generator spend in a separate evaluation ledger. A provider
whose price or token usage is unavailable must not be assigned zero cost.

Each rubric judgment is supplied by a separate grading step:

```json
{
  "rubric_id": "exact-rubric-id-from-case",
  "passed": true,
  "judge": {
    "kind": "human",
    "id": "reviewer-or-blinded-judge-policy-id",
    "version": "rubric-and-judge-version",
    "calibration_id": "review-evidence-or-calibration-study-id"
  },
  "evidence": ["source-span and answer-span supporting this verdict"]
}
```

`kind` can be `human` or `model`. Insufficient evidence is represented by an
absent judgment, not a guessed pass. Partial-credit/issue-level diagnostic
scores belong in versioned trace evidence until a reviewed scorer is added;
the current promotion checks are binary. Judge labels are trusted input from
the grading pipeline, not candidate-authored labels. An ID alone cannot prove
calibration, independence, human expertise or evidence validity.

## Scores and comparisons

All planned trials remain in status counts. `deterministic_pass_rate` is a
narrow contract score. `fully_graded_rate` measures completed trials with every
rubric judgment. `confirmed_pass_rate` is the lower bound of confirmed whole
task passes divided by all planned trials. `pass_rate` is `null` if a completed
deterministic-pass answer still lacks rubric judgments. Missing/error/timeout/
cancelled trials fail task success. Critical failures are reported independently
of terminal status when supplied evidence proves a violation; unassessed
critical evidence is counted in `critical_assessment_unknown`. Zero observed
violations does not imply zero risk.

`any_trial_success_rate` and `all_trial_success_rate` use cases as their units;
they are `null` when task quality is unresolved. They distinguish best observed
trial from consistent success, and are not an unbiased pass@k estimator. Report
the number of trials. Per-family summaries and raw check/rubric results support
diagnosis without averaging away critical failures.

Metric summaries include measured/planned counts, coverage, nearest-rank p50/p95,
observed sum and complete sum. `complete_sum` is `null` if any planned telemetry
is missing. Quantiles include failed observed attempts, not just successful
responses; timeouts are censored at their deadline and need separate reporting.
Tiny-sample p95 is descriptive, not a production SLO estimate.

`compare --axis model` requires identical environments, suite and trial plans;
model/provider/decoding configuration differences are disclosed in candidate
metadata. `--axis system` allows product/prompt/environment changes and cannot
attribute differences solely to model choice. Paired rubric judgments must use
the same judge identity/version/calibration; regrade both candidates after a
judge change. If either side has unresolved task quality, the affected quality
delta is `null` with `quality_coverage` reported. Do not rank lower bounds.

Quality deltas are candidate minus baseline; higher is better. Mean paired
latency/cost deltas also use candidate minus baseline; lower is better. The
deterministically seeded 2,000-resample percentile bootstrap resamples whole
matters with all their cases/trials. Fewer than two matters yields no interval.
Correlated variants still require correct matter IDs; bootstrap cannot repair
bad corpus lineage. Telemetry comparisons use only measured pairs and disclose
paired coverage; missing trials remain failures in quality. There is no
automatic significance, noninferiority or release declaration.

Reports are decision support only. Semantic validation, sealed-corpus controls,
predeclared gates and expert review in the [decision protocol](model-selection.md)
are required before choosing a model.
