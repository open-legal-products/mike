import test from 'node:test';
import assert from 'node:assert/strict';
import { check, clusterInterval, compare, gradeCase, score, suiteHash, validateCapture, validateSuite } from './lib.mjs';

const cases = [1, 2].map(i => ({
  id: `case-${i}`, workflow_id: 'retrieval', split: 'dev', matter_id: `matter-${i}`,
  provenance: { kind: 'synthetic', review_status: 'unreviewed', notes: 'Harness failure-injection test only.' },
  input: { prompt: 'Extract the period with evidence.', documents: [{ id: 'source', text: 'Notice is 30 days.' }] },
  assertions: [
    { kind: 'equals', path: 'output.days', value: 30, critical: true },
    { kind: 'set_equals', path: 'output.citations', value: ['source:1'], critical: true },
    { kind: 'excludes', path: 'output.answer', value: '60 days', critical: false },
  ],
  rubric: [{ id: 'grounding', criterion: 'The citation actually supports the entire claim.', critical: true }],
  reference_output: { days: 30, citations: ['source:1'], answer: '30 days' }, tags: [i === 2 ? 'negative' : 'normal'],
}));
const workflows = { version: 1, source_commit: 'a'.repeat(40), workflows: [{
  id: 'retrieval', title: 'Retrieval', source_paths: ['backend/src/modules/chat'], metrics: ['grounding'], risks: ['fabrication'],
}] };
const suite = { cases, workflows, hash: suiteHash(workflows, cases) };
const clone = value => structuredClone(value);
function capture() {
  return {
    version: 1,
    run: {
      id: 'run-1', kind: 'product_capture', suite_sha256: suite.hash,
      candidate: { id: 'candidate-1', provider: 'test-provider', model: 'test-model', settings: { temperature: 0 } },
      environment: { product_commit: 'a'.repeat(40), catalog_commit: 'b'.repeat(40), prompt_version: 'sha256:prompt', tools_version: 'sha256:tools', execution_policy_version: 'sha256:fixed-retry-timeout-cache-region-concurrency-policy' },
      trial_seeds: [42, 43],
    },
    observations: cases.flatMap(item => [1, 2].map(trial => ({
      case_id: item.id, trial, seed: trial === 1 ? 42 : 43, status: 'completed', output: clone(item.reference_output),
      measurements: { e2e_ms: 100, ttft_ms: 20, provider_ms: 80, queue_ms: 0, input_tokens: 40, output_tokens: 10,
        cost_usd: 0.001, retries: 0, tool_calls: 1 },
      evidence: { trace_id: `trace-${item.id}-${trial}` },
      judgments: [{ rubric_id: 'grounding', passed: true, judge: { kind: 'human', id: 'reviewer-test', version: 'rubric-v1', calibration_id: 'test-only' }, evidence: ['source:1 supports 30 days'] }],
    }))),
  };
}

test('reference validation catches a contradictory gold answer', async () => {
  await validateSuite(workflows, cases);
  const broken = clone(cases);
  broken[0].reference_output.days = 60;
  await assert.rejects(validateSuite(workflows, broken), /reference fails/);
});

test('one matter cannot leak between development and holdout', async () => {
  const broken = clone(cases);
  broken[1].matter_id = broken[0].matter_id;
  broken[1].split = 'holdout';
  await assert.rejects(validateSuite(workflows, broken), /crosses splits/);
});

test('typed scope recipes reject overlap, unknown IDs and child expansion', async () => {
  const broken = clone(cases);
  broken[0].setup = { actor_role: 'editor', fixture_notes: 'Synthetic scope setup', candidate_document_ids: ['source'], denied_document_ids: ['source'] };
  await assert.rejects(validateSuite(workflows, broken), /overlap/);
  broken[0].setup.denied_document_ids = ['made-up'];
  await assert.rejects(validateSuite(workflows, broken), /unique fixture IDs/);
  broken[0].setup.denied_document_ids = [];
  broken[0].setup.child_document_ids = ['made-up'];
  await assert.rejects(validateSuite(workflows, broken), /subset/);
});

test('validation rejects unsupported families and positive-only coverage', async () => {
  const broken = clone(cases);
  broken[1].tags = ['normal'];
  await assert.rejects(validateSuite(workflows, broken), /negative or adversarial/);
  broken[1].tags = ['negative'];
  broken[1].workflow_id = 'nonexistent';
  await assert.rejects(validateSuite(workflows, broken), /two development cases/);
});

test('missing fields and wrong types cannot satisfy negative checks', () => {
  const assertion = { kind: 'excludes', path: 'output.answer', value: 'secret' };
  assert.equal(check(assertion, {}), false);
  assert.equal(check(assertion, { answer: null }), false);
  assert.equal(check(assertion, { answer: 'safe' }), true);
  assert.equal(check({ kind: 'equals', path: 'output.answer', value: 'safe' }, Object.create({ answer: 'safe' })), false);
});

test('set checks reject duplicate or fabricated citations and ignore order', () => {
  const assertion = { kind: 'set_equals', path: 'output.citations', value: ['a', 'b'] };
  assert.equal(check(assertion, { citations: ['b', 'a'] }), true);
  assert.equal(check(assertion, { citations: ['a', 'b', 'b'] }), false);
  assert.equal(check(assertion, { citations: ['a', 'invented'] }), false);
});

test('a critical failure cannot be rescued by a passing legal judge', () => {
  const row = capture().observations[0];
  row.output.days = 60;
  const grade = gradeCase(cases[0], row);
  assert.equal(grade.critical_failure, true);
  assert.equal(grade.passed, false);
});

test('missing rubric judgments are pending, never a pass', () => {
  const row = capture().observations[0];
  row.judgments = [];
  const grade = gradeCase(cases[0], row);
  assert.equal(grade.deterministic_pass, true);
  assert.equal(grade.fully_graded, false);
  assert.equal(grade.passed, false);
});

test('failed attempts cannot pass even with a plausible partial output', () => {
  const row = capture().observations[0];
  row.status = 'timeout';
  assert.equal(gradeCase(cases[0], row).passed, false);
});

test('a timeout cannot hide an independently observed critical violation', () => {
  const row = capture().observations[0];
  row.status = 'timeout';
  row.output.days = 60;
  assert.equal(gradeCase(cases[0], row).critical_failure, true);
  row.output = {};
  row.judgments = [];
  const missing = gradeCase(cases[0], row);
  assert.equal(missing.critical_failure, false);
  assert.equal(missing.critical_assessment_unknown, true);
});

test('all scheduled attempts remain in the denominator', () => {
  const data = capture();
  data.observations.pop();
  data.observations[0].status = 'error';
  const result = score(data, suite);
  assert.equal(result.overall.planned, 4);
  assert.equal(result.overall.observed, 3);
  assert.equal(result.overall.status_counts.missing, 1);
  assert.equal(result.overall.status_counts.error, 1);
  assert.equal(result.overall.pass_rate, 0.5);
  assert.equal(result.overall.any_trial_success_rate, 1);
  assert.equal(result.overall.all_trial_success_rate, 0);
});

test('unknown cases, duplicate trials and seed mismatch are rejected', () => {
  const unknown = capture();
  unknown.observations[0].case_id = 'made-up';
  assert.throws(() => validateCapture(unknown, suite), /Unknown case/);
  const duplicate = capture();
  duplicate.observations.push(clone(duplicate.observations[0]));
  assert.throws(() => validateCapture(duplicate, suite), /Duplicate observation/);
  const mismatch = capture();
  mismatch.observations[0].seed = 999;
  assert.throws(() => validateCapture(mismatch, suite), /trial\/seed mismatch/);
});

test('mutating a fixture invalidates a capture binding', () => {
  const changedSuite = clone(suite);
  changedSuite.cases[0].input.documents[0].text = 'Notice is 60 days.';
  changedSuite.hash = suiteHash(workflows, changedSuite.cases);
  assert.throws(() => score(capture(), changedSuite), /suite hash/);
});

test('mutable product/catalog branch names cannot substitute for frozen versions', () => {
  const data = capture();
  data.run.environment.product_commit = 'main';
  assert.throws(() => score(data, suite), /immutable/);
});

test('missing cost is unknown, while zero queue time remains a real measurement', () => {
  const data = capture();
  data.observations[0].measurements.cost_usd = null;
  const result = score(data, suite);
  assert.equal(result.overall.metrics.cost_usd.measured, 3);
  assert.equal(result.overall.metrics.cost_usd.complete_sum, null);
  assert.equal(result.overall.metrics.queue_ms.measured, 4);
  assert.equal(result.overall.metrics.queue_ms.complete_sum, 0);
});

test('invalid negative/NaN telemetry and omitted measurement keys are rejected', () => {
  for (const value of [-1, NaN, '100', undefined]) {
    const data = capture();
    data.observations[0].measurements.e2e_ms = value;
    assert.throws(() => score(data, suite), /e2e_ms/);
  }
  const data = capture();
  data.observations[0].measurements.ttft_ms = 200;
  assert.throws(() => score(data, suite), /TTFT/);
});

test('unsupported or duplicate rubric labels cannot inflate pass rate', () => {
  const duplicate = capture();
  duplicate.observations[0].judgments.push(clone(duplicate.observations[0].judgments[0]));
  assert.throws(() => score(duplicate, suite), /duplicate rubric/);
  const unsupported = capture();
  unsupported.observations[0].judgments[0].rubric_id = 'vibes';
  assert.throws(() => score(unsupported, suite), /invalid judgment/);
  const unsupportedJudge = capture();
  unsupportedJudge.observations[0].judgments[0].judge.calibration_id = '';
  assert.throws(() => score(unsupportedJudge, suite), /calibration evidence/);
});

test('fixture and unreviewed corpus scores cannot become release evidence', () => {
  const data = capture();
  data.run.kind = 'reference_fixture';
  const result = score(data, suite);
  assert.equal(result.decision_eligible, false);
  assert.equal(result.overall.pass_rate, 1);
  assert.match(result.limitations.join(' '), /not a model/);
  assert.throws(() => compare(data, capture(), suite), /Reference fixtures/);
});

test('comparisons enforce matched trial plans and environment for model claims', () => {
  const differentEnvironment = capture();
  differentEnvironment.run.environment.prompt_version = 'changed';
  assert.throws(() => compare(capture(), differentEnvironment, suite), /identical product/);
  assert.equal(compare(capture(), differentEnvironment, suite, 'system').axis, 'system');
  const differentPlan = capture();
  differentPlan.run.trial_seeds = [44, 45];
  differentPlan.observations.forEach(row => { row.seed += 2; });
  assert.throws(() => compare(capture(), differentPlan, suite), /identical planned/);
  const differentRetryPolicy = capture();
  differentRetryPolicy.run.environment.execution_policy_version = 'different-retries';
  assert.throws(() => compare(capture(), differentRetryPolicy, suite), /identical product/);
});

test('paired comparison preserves missing trials and reports telemetry coverage', () => {
  const candidate = capture();
  candidate.observations.pop();
  const result = compare(capture(), candidate, suite);
  assert.equal(result.overall.pass_rate_delta.estimate, -0.25);
  assert.equal(result.overall.mean_metric_delta.e2e_ms.paired_coverage, 0.75);
  assert.equal(result.scores.candidate.overall.status_counts.missing, 1);
});

test('judge drift and missing legal grades cannot masquerade as model gains', () => {
  const drift = capture();
  drift.observations[0].judgments[0].judge.version = 'different-judge';
  assert.throws(() => compare(capture(), drift, suite), /same judge identity/);
  const pending = capture();
  pending.observations[0].judgments = [];
  const result = compare(pending, capture(), suite);
  assert.equal(result.overall.pass_rate_delta.estimate, null);
  assert.equal(result.overall.pass_rate_delta.quality_coverage, 0.75);
  assert.equal(result.scores.baseline.overall.pass_rate, null);
  assert.equal(result.scores.baseline.overall.quality_unknown, 1);
});

test('bootstrap clusters matters instead of treating repeated trials as independent', () => {
  const pairs = [{ matter_id: 'one', value: 0 }, { matter_id: 'one', value: 1 }];
  const result = clusterInterval(pairs, list => list.reduce((n, row) => n + row.value, 0) / list.length);
  assert.equal(result.matters, 1);
  assert.equal(result.ci95, null);
  const more = [...pairs, { matter_id: 'two', value: 1 }];
  const statistic = list => list.reduce((n, row) => n + row.value, 0) / list.length;
  assert.deepEqual(clusterInterval(more, statistic), clusterInterval(more, statistic));
});
