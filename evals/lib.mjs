import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const unique = list => new Set(list).size === list.length;
const equal = (a, b) => canonical(a) === canonical(b);
const own = (obj, key) => Object.hasOwn(obj, key);

export function suiteHash(workflows, cases) {
  return createHash('sha256').update(canonical({ workflows, cases })).digest('hex');
}

export async function jsonl(path) {
  const source = await readFile(path, 'utf8');
  return source.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`${path}:${i + 1}: invalid JSON`); }
  });
}

export function field(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!object(current) && !Array.isArray(current)) return { exists: false };
    if (!own(current, segment)) return { exists: false };
    current = current[segment];
  }
  return { exists: true, value: current };
}

export function check(assertion, output) {
  const actual = field({ output }, assertion.path);
  // A missing field never passes, including an excludes assertion.
  if (!actual.exists) return false;
  switch (assertion.kind) {
    case 'equals': return equal(actual.value, assertion.value);
    case 'includes':
    case 'excludes': {
      const contains = typeof actual.value === 'string' && typeof assertion.value === 'string'
        ? actual.value.includes(assertion.value)
        : Array.isArray(actual.value) ? actual.value.some(item => equal(item, assertion.value)) : null;
      return contains !== null && (assertion.kind === 'includes' ? contains : !contains);
    }
    case 'set_equals': {
      if (!Array.isArray(actual.value) || !Array.isArray(assertion.value)) return false;
      const a = actual.value.map(canonical).sort();
      const b = assertion.value.map(canonical).sort();
      return unique(a) && unique(b) && equal(a, b);
    }
    default: throw new Error(`Unknown assertion kind: ${assertion.kind}`);
  }
}

export async function validateSuite(workflows, cases, root) {
  invariant(workflows.version === 1 && Array.isArray(workflows.workflows) && workflows.workflows.length > 0,
    'Workflow manifest version 1 and nonempty workflows required');
  invariant(/^[a-f0-9]{40}$/.test(workflows.source_commit), 'Manifest needs immutable product source_commit');
  const ids = workflows.workflows.map(workflow => workflow.id);
  invariant(ids.every(text) && unique(ids), 'Workflow IDs must be nonempty and unique');
  invariant(cases.length > 0 && unique(cases.map(item => item.id)), 'Nonempty cases with unique IDs required');
  for (const workflow of workflows.workflows) {
    invariant(text(workflow.title) && workflow.source_paths?.length && workflow.metrics?.length && workflow.risks?.length,
      `${workflow.id}: title, source paths, metrics and risks required`);
    for (const path of workflow.source_paths) {
      invariant(text(path) && !path.startsWith('/') && !path.split('/').includes('..'), `${workflow.id}: unsafe source path`);
      if (root) await access(resolve(root, path));
    }
    const seeds = cases.filter(item => item.workflow_id === workflow.id);
    invariant(seeds.length >= 2, `${workflow.id}: at least two development cases required`);
    invariant(seeds.some(item => item.tags?.some(tag => ['negative', 'adversarial'].includes(tag))),
      `${workflow.id}: negative or adversarial case required`);
  }
  const matterSplits = new Map();
  for (const item of cases) {
    const label = item.id;
    invariant(text(label) && ids.includes(item.workflow_id) && text(item.matter_id), `${label}: unknown workflow or matter`);
    invariant(['dev', 'calibration', 'holdout', 'regression'].includes(item.split), `${label}: invalid split`);
    invariant(!matterSplits.has(item.matter_id) || matterSplits.get(item.matter_id) === item.split,
      `${label}: matter crosses splits`);
    matterSplits.set(item.matter_id, item.split);
    invariant(['synthetic', 'public', 'consented_trace'].includes(item.provenance?.kind), `${label}: provenance required`);
    invariant(['unreviewed', 'approved'].includes(item.provenance?.review_status) && text(item.provenance.notes),
      `${label}: review status and provenance notes required`);
    if (item.provenance.review_status === 'approved') {
      invariant(text(item.provenance.review_id) && text(item.provenance.reviewer), `${label}: approved cases need review evidence`);
    }
    invariant(text(item.input?.prompt) && Array.isArray(item.input.documents), `${label}: prompt/documents required`);
    invariant(unique(item.input.documents.map(doc => doc.id)) && item.input.documents.every(doc => text(doc.id) && text(doc.text)),
      `${label}: document IDs and source text required`);
    if (item.setup) {
      const setup = item.setup;
      const documentIds = item.input.documents.map(doc => doc.id);
      invariant(text(setup.actor_role) && text(setup.fixture_notes), `${label}: actor role and setup notes required`);
      for (const name of ['candidate_document_ids', 'denied_document_ids']) {
        invariant(Array.isArray(setup[name]) && unique(setup[name]) && setup[name].every(id => documentIds.includes(id)),
          `${label}: ${name} must contain unique fixture IDs`);
      }
      invariant(!setup.candidate_document_ids.some(id => setup.denied_document_ids.includes(id)), `${label}: candidate and denied documents overlap`);
      if (setup.child_document_ids) {
        invariant(Array.isArray(setup.child_document_ids) && unique(setup.child_document_ids)
          && setup.child_document_ids.every(id => setup.candidate_document_ids.includes(id)), `${label}: child scope must be a subset of parent scope`);
      }
    }
    invariant(Array.isArray(item.assertions) && item.assertions.length > 0 && Array.isArray(item.rubric) && item.rubric.length > 0,
      `${label}: deterministic assertions and rubric required`);
    for (const a of item.assertions) {
      invariant(['equals', 'includes', 'excludes', 'set_equals'].includes(a.kind) && typeof a.critical === 'boolean'
        && typeof a.path === 'string' && /^output\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(a.path) && own(a, 'value'),
      `${label}: invalid assertion`);
      invariant(!a.path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), `${label}: unsafe assertion path`);
      if (a.kind === 'set_equals') invariant(Array.isArray(a.value) && unique(a.value.map(canonical)), `${label}: set must have unique items`);
      invariant(check(a, item.reference_output), `${label}: reference fails ${a.path} ${a.kind}`);
    }
    invariant(unique(item.rubric.map(r => r.id)) && item.rubric.every(r => text(r.id) && text(r.criterion) && typeof r.critical === 'boolean'),
      `${label}: invalid or duplicate rubric`);
  }
  return { workflows: ids.length, cases: cases.length, matters: matterSplits.size, suite_sha256: suiteHash(workflows, cases) };
}

const metricNames = ['e2e_ms', 'ttft_ms', 'provider_ms', 'queue_ms', 'input_tokens', 'output_tokens', 'cost_usd'];

export function validateCapture(capture, suite) {
  const run = capture.run;
  invariant(capture.version === 1 && object(run), 'Capture version 1 and run required');
  invariant(text(run.id) && ['product_capture', 'reference_fixture'].includes(run.kind), 'Run ID and kind required');
  invariant(run.suite_sha256 === suite.hash, 'Capture suite hash does not match current definitions');
  invariant(object(run.candidate) && ['id', 'provider', 'model'].every(key => text(run.candidate[key]))
    && object(run.candidate.settings), 'Candidate identity and explicit settings required');
  invariant(object(run.environment) && ['product_commit', 'catalog_commit', 'prompt_version', 'tools_version', 'execution_policy_version'].every(key => text(run.environment[key])),
    'Product/catalog/prompt/tools/execution-policy versions required');
  invariant(['product_commit', 'catalog_commit'].every(key => /^[a-f0-9]{40}$/.test(run.environment[key])),
    'Product and catalog commits must be immutable 40-character Git SHAs');
  invariant(Array.isArray(run.trial_seeds) && run.trial_seeds.length > 0
    && run.trial_seeds.every(Number.isSafeInteger) && unique(run.trial_seeds), 'Distinct integer trial seeds required');
  invariant(Array.isArray(capture.observations), 'Observations array required');
  const seen = new Set();
  for (const row of capture.observations) {
    invariant(suite.cases.some(item => item.id === row.case_id), `Unknown case: ${row.case_id}`);
    const item = suite.cases.find(item => item.id === row.case_id);
    invariant(Number.isInteger(row.trial) && row.trial > 0 && row.trial <= run.trial_seeds.length
      && row.seed === run.trial_seeds[row.trial - 1], `${row.case_id}: trial/seed mismatch`);
    const key = `${row.case_id}:${row.trial}`;
    invariant(!seen.has(key), `Duplicate observation: ${key}`);
    seen.add(key);
    invariant(['completed', 'error', 'timeout', 'cancelled'].includes(row.status), `${key}: invalid status`);
    invariant(object(row.output) && object(row.measurements), `${key}: output and measurements required`);
    for (const name of metricNames) {
      invariant(own(row.measurements, name) && (finite(row.measurements[name]) || row.measurements[name] === null), `${key}: invalid ${name}`);
    }
    invariant(finite(row.measurements.e2e_ms), `${key}: observed attempts need elapsed time, including failures`);
    for (const name of ['input_tokens', 'output_tokens', 'retries', 'tool_calls']) {
      invariant((name.endsWith('_tokens') && row.measurements[name] === null)
        || (Number.isSafeInteger(row.measurements[name]) && row.measurements[name] >= 0), `${key}: invalid ${name}`);
    }
    if (row.measurements.ttft_ms !== null) invariant(row.measurements.ttft_ms <= row.measurements.e2e_ms, `${key}: TTFT exceeds end-to-end time`);
    invariant(text(row.evidence?.trace_id), `${key}: trace ID required`);
    invariant(Array.isArray(row.judgments), `${key}: judgments array required (may be empty while pending)`);
    invariant(unique(row.judgments.map(j => j.rubric_id)), `${key}: duplicate rubric judgments`);
    for (const judgment of row.judgments) {
      invariant(item.rubric.some(r => r.id === judgment.rubric_id) && typeof judgment.passed === 'boolean', `${key}: invalid judgment`);
      invariant(['human', 'model'].includes(judgment.judge?.kind) && ['id', 'version', 'calibration_id'].every(k => text(judgment.judge[k])),
        `${key}: judge identity/version/calibration evidence required`);
      invariant(Array.isArray(judgment.evidence) && judgment.evidence.length > 0 && judgment.evidence.every(text), `${key}: judgment evidence required`);
    }
  }
  return capture;
}

export function gradeCase(item, observation) {
  const checks = item.assertions.map(a => {
    const observed = observation && field({ output: observation.output }, a.path).exists;
    const assessment = !observed && observation?.status !== 'completed' ? 'unknown'
      : check(a, observation?.output) ? 'pass' : 'fail';
    return { path: a.path, kind: a.kind, critical: a.critical, assessment,
      passed: observation?.status === 'completed' && assessment === 'pass' };
  });
  const rubrics = item.rubric.map(r => {
    const judgment = observation?.judgments.find(j => j.rubric_id === r.id);
    return { id: r.id, critical: r.critical, passed: judgment?.passed ?? null };
  });
  const complete = observation?.status === 'completed';
  return {
    status: observation?.status ?? 'missing', checks, rubrics,
    deterministic_pass: Boolean(complete && checks.every(c => c.passed)),
    fully_graded: Boolean(complete && rubrics.every(r => r.passed !== null)),
    passed: Boolean(complete && checks.every(c => c.passed) && rubrics.every(r => r.passed === true)),
    critical_failure: checks.some(c => c.critical && c.assessment === 'fail') || rubrics.some(r => r.critical && r.passed === false),
    critical_assessment_unknown: checks.some(c => c.critical && c.assessment === 'unknown') || rubrics.some(r => r.critical && r.passed === null),
  };
}

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: avoid interpolating a reassuring p95 from a tiny sample.
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function metrics(rows) {
  const result = {};
  for (const name of metricNames) {
    const values = rows.map(r => r.observation?.measurements[name]).filter(finite);
    result[name] = { measured: values.length, planned: rows.length, coverage: values.length / rows.length,
      p50: quantile(values, 0.5), p95: quantile(values, 0.95),
      observed_sum: values.length ? values.reduce((a, b) => a + b, 0) : null,
      complete_sum: values.length === rows.length ? values.reduce((a, b) => a + b, 0) : null };
  }
  return result;
}

function summarize(rows) {
  const count = predicate => rows.filter(predicate).length;
  const cases = [...new Set(rows.map(r => r.case_id))];
  const unknown = count(r => r.status === 'completed' && r.deterministic_pass && !r.fully_graded);
  return {
    planned: rows.length, observed: count(r => r.status !== 'missing'),
    status_counts: Object.fromEntries(['completed', 'error', 'timeout', 'cancelled', 'missing'].map(s => [s, count(r => r.status === s)])),
    deterministic_pass_rate: count(r => r.deterministic_pass) / rows.length,
    fully_graded_rate: count(r => r.fully_graded) / rows.length,
    quality_unknown: unknown,
    confirmed_pass_rate: count(r => r.passed) / rows.length,
    pass_rate: unknown ? null : count(r => r.passed) / rows.length,
    critical_failures: count(r => r.critical_failure),
    critical_assessment_unknown: count(r => r.critical_assessment_unknown),
    any_trial_success_rate: unknown ? null : cases.filter(id => rows.some(r => r.case_id === id && r.passed)).length / cases.length,
    all_trial_success_rate: unknown ? null : cases.filter(id => rows.filter(r => r.case_id === id).every(r => r.passed)).length / cases.length,
    metrics: metrics(rows),
  };
}

export function score(capture, suite) {
  validateCapture(capture, suite);
  const observations = new Map(capture.observations.map(row => [`${row.case_id}:${row.trial}`, row]));
  const rows = suite.cases.flatMap(item => capture.run.trial_seeds.map((seed, index) => {
    const observation = observations.get(`${item.id}:${index + 1}`);
    return { case_id: item.id, workflow_id: item.workflow_id, matter_id: item.matter_id, trial: index + 1, seed,
      ...gradeCase(item, observation), observation };
  }));
  return {
    version: 1, run: capture.run, decision_eligible: false,
    limitations: ['Offline scoring cannot establish capture integrity, judge calibration or sealed-holdout integrity.',
      ...(suite.cases.some(c => c.provenance.review_status !== 'approved') ? ['Corpus contains unreviewed cases.'] : []),
      ...(capture.run.kind === 'reference_fixture' ? ['Reference fixtures test the harness, not a model or product.'] : [])],
    overall: summarize(rows),
    by_workflow: Object.fromEntries([...new Set(rows.map(row => row.workflow_id))].map(id => [id, summarize(rows.filter(row => row.workflow_id === id))])),
    rows,
  };
}

function random(seed = 20261027) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

export function clusterInterval(pairs, statistic, iterations = 2000) {
  const matters = [...new Set(pairs.map(p => p.matter_id))];
  const estimate = pairs.length ? statistic(pairs) : null;
  if (matters.length < 2) return { estimate, ci95: null, matters: matters.length, paired_trials: pairs.length };
  const groups = matters.map(id => pairs.filter(p => p.matter_id === id));
  const rand = random();
  const samples = Array.from({ length: iterations }, () => {
    const selected = Array.from({ length: groups.length }, () => groups[Math.floor(rand() * groups.length)]).flat();
    return statistic(selected);
  });
  return { estimate, ci95: [quantile(samples, 0.025), quantile(samples, 0.975)], matters: matters.length, paired_trials: pairs.length };
}

export function compare(baselineCapture, candidateCapture, suite, axis = 'model') {
  invariant(['model', 'system'].includes(axis), 'Comparison axis must be model or system');
  const baseline = score(baselineCapture, suite);
  const candidate = score(candidateCapture, suite);
  invariant(baseline.run.kind === 'product_capture' && candidate.run.kind === 'product_capture', 'Reference fixtures cannot enter model comparisons');
  invariant(equal(baseline.run.trial_seeds, candidate.run.trial_seeds), 'Comparisons require identical planned trials/seeds');
  if (axis === 'model') invariant(equal(baseline.run.environment, candidate.run.environment), 'Model comparisons require identical product/prompt/catalog/tool environments');
  const pairs = baseline.rows.map((row, i) => ({ matter_id: row.matter_id, workflow_id: row.workflow_id, baseline: row, candidate: candidate.rows[i] }));
  for (const pair of pairs) {
    for (const judgment of pair.baseline.observation?.judgments ?? []) {
      const other = pair.candidate.observation?.judgments.find(j => j.rubric_id === judgment.rubric_id);
      invariant(!other || equal(judgment.judge, other.judge), `${pair.baseline.case_id}: comparisons require the same judge identity/version/calibration for each paired rubric`);
    }
  }
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const slice = selected => {
    const known = row => row.status !== 'completed' || !row.deterministic_pass || row.fully_graded;
    const qualityPairs = selected.filter(p => known(p.baseline) && known(p.candidate));
    // Do not compare lower bounds or silently discard incompletely graded successes.
    const quality = qualityPairs.length === selected.length
      ? clusterInterval(selected, list => mean(list.map(p => Number(p.candidate.passed) - Number(p.baseline.passed))))
      : { estimate: null, ci95: null, matters: new Set(selected.map(p => p.matter_id)).size, paired_trials: selected.length };
    quality.quality_pairs = qualityPairs.length;
    quality.quality_coverage = qualityPairs.length / selected.length;
    const telemetry = {};
    for (const name of ['e2e_ms', 'ttft_ms', 'cost_usd']) {
      const measured = selected.filter(p => finite(p.baseline.observation?.measurements[name]) && finite(p.candidate.observation?.measurements[name]));
      telemetry[name] = { ...clusterInterval(measured, list => mean(list.map(p => p.candidate.observation.measurements[name] - p.baseline.observation.measurements[name]))),
        planned: selected.length, paired_coverage: measured.length / selected.length };
    }
    return { pass_rate_delta: quality, mean_metric_delta: telemetry };
  };
  return {
    version: 1, axis, baseline: baseline.run, candidate: candidate.run, decision_eligible: false,
    limitations: [...new Set([...baseline.limitations, ...candidate.limitations,
      'Positive pass-rate deltas favor the candidate; negative latency/cost deltas favor the candidate.',
      'Paired percentile bootstrap resamples entire matters; small or synthetic samples do not justify model selection.',
      'Telemetry deltas include failed observed attempts; missing telemetry is excluded with coverage shown.',
      ...(axis === 'system' ? ['Whole-system comparison: differences cannot be attributed solely to the model.'] : [])])],
    overall: slice(pairs),
    by_workflow: Object.fromEntries([...new Set(pairs.map(p => p.workflow_id))].map(id => [id, slice(pairs.filter(p => p.workflow_id === id))])),
    scores: { baseline: { overall: baseline.overall, by_workflow: baseline.by_workflow }, candidate: { overall: candidate.overall, by_workflow: candidate.by_workflow } },
  };
}
