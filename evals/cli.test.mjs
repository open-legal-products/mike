import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonl, suiteHash } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, ['evals/run.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('CLI validates the real registry and labels reference smoke honestly', () => {
  const validation = cli('validate');
  assert.equal(validation.status, 0, validation.stderr);
  const summary = JSON.parse(validation.stdout);
  assert.ok(summary.workflows >= 22);
  assert.ok(summary.cases >= 44);
  const smoke = cli('smoke');
  assert.equal(smoke.status, 0, smoke.stderr);
  const result = JSON.parse(smoke.stdout);
  assert.equal(result.model_or_product_evaluated, false);
  assert.equal(result.legal_quality_evaluated, false);
  assert.equal(result.decision_eligible, false);
});

test('CLI rejects typos rather than silently ignoring comparison controls', () => {
  for (const args of [[], ['score'], ['compare', '--axes', 'model'], ['smoke', '--responses', 'anything']]) {
    const result = cli(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Eval error:/);
  }
});

test('recorded score keeps a missing planned grid and creates private outputs without overwriting', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mike-eval-cli-'));
  try {
    const workflows = JSON.parse(await readFile(join(root, 'evals/workflows.json'), 'utf8'));
    const cases = await jsonl(join(root, 'evals/cases/seed.jsonl'));
    const input = join(folder, 'capture.json');
    const output = join(folder, 'score.json');
    await writeFile(input, JSON.stringify({ version: 1, run: {
      id: 'empty-failure-injection-run', kind: 'reference_fixture', suite_sha256: suiteHash(workflows, cases),
      candidate: { id: 'no-model', provider: 'none', model: 'none', settings: {} },
      environment: { product_commit: workflows.source_commit, catalog_commit: 'b'.repeat(40),
        prompt_version: 'test-only', tools_version: 'test-only', execution_policy_version: 'test-only' },
      trial_seeds: [42],
    }, observations: [] }));
    const result = cli('score', '--responses', input, '--out', output);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.overall.planned, cases.length);
    assert.equal(report.overall.status_counts.missing, cases.length);
    assert.equal(report.overall.pass_rate, 0);
    assert.equal(report.overall.metrics.cost_usd.complete_sum, null);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const second = cli('score', '--responses', input, '--out', output);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).overall.planned, cases.length);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
