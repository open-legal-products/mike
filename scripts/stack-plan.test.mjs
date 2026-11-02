import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const planner = fileURLToPath(new URL('./stack-volumes.jq', import.meta.url));
const day = 86400;
const now = 1800000000;
const stamp = seconds => new Date(seconds * 1000).toISOString();
const project = 'mike-test';
const volume = (name = 'data', labels = {}) => ({ Name: name, CreatedAt: stamp(now - 30 * day),
  Labels: { 'com.docker.compose.project': project, ...labels } });
const container = (status = 'exited', finished = now - 60) => ({ Id: 'db',
  Config: { Labels: { 'com.docker.compose.project': project } }, Created: stamp(now - 30 * day),
  State: { Status: status, StartedAt: stamp(now - 20 * day), FinishedAt: stamp(finished) },
  Mounts: [{ Type: 'volume', Name: 'data' }] });
const record = (idle = now - 60, v = volume()) => ({ version: 1, volumes: { [v.Name]: {
  created: v.CreatedAt, project, supabase: '', idle_since: idle,
} } });
function plan({ cs = [container()], vs = [volume()], previous = { version: 1, volumes: {} },
  kind = 'mike', scope = true, time = now, age = 7 * day, only = 'mike-*', allowed = '' } = {}) {
  const args = ['-n'];
  for (const [key, value] of Object.entries({ containers: [cs], volumes: [vs], previous: [previous], now: time, age })) {
    args.push('--argjson', key, JSON.stringify(value));
  }
  args.push('--arg', 'classifications', `${project}\t${kind}\t${scope}\n`,
    '--arg', 'only', only, '--arg', 'allowed', allowed, '-f', planner);
  const result = spawnSync('jq', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const status of ['running', 'paused', 'restarting', 'removing', 'unknown']) {
  test(`protects ${status} containers and declared unmounted volumes`, () => {
    const p = plan({ cs: [container(status)], vs: [volume(), volume('unused')], age: 0 });
    assert.deepEqual(p.containers, []);
    assert.deepEqual(p.remove, []);
    assert.deepEqual(p.protected, [project]);
  });
}
for (const status of ['exited', 'dead', 'created']) {
  test(`removes ${status} containers but keeps recently used data`, () => {
    const p = plan({ cs: [container(status)] });
    assert.deepEqual(p.containers, ['db']);
    assert.deepEqual(p.remove, []);
  });
}
test('second sweep retains recent use; data expires only after the idle threshold', () => {
  const first = plan();
  const second = plan({ cs: [], kind: 'unknown', previous: first.state, time: now + 1 });
  assert.deepEqual(second.remove, []);
  const expired = plan({ cs: [], kind: 'unknown', previous: second.state, time: now + 8 * day });
  assert.deepEqual(expired.remove, ['data']);
});
test('known foreign project vetoes a saved record and a mike-prefixed name', () => {
  const foreign = { ...container(), Mounts: [] };
  const p = plan({ cs: [foreign], kind: 'other', previous: record(now - 30 * day), age: 0 });
  assert.deepEqual(p.containers, []);
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.state.volumes, {});
});
test('unknown named volumes are kept even with a mike project prefix', () => {
  assert.deepEqual(plan({ cs: [], kind: 'unknown', age: 0 }).remove, []);
});
test('preview includes a volume attached only to an eligible stopped stack', () => {
  const p = plan({ cs: [container('exited', now - 10 * day)] });
  assert.deepEqual(p.containers, ['db']);
  assert.deepEqual(p.remove, ['data']);
});
test('a shared volume still referenced by a non-Compose container is kept', () => {
  const external = { ...container('exited'), Id: 'foreign', Config: { Labels: {} } };
  const p = plan({ cs: [container('exited', now - 10 * day), external] });
  assert.deepEqual(p.containers, ['db']);
  assert.deepEqual(p.remove, []);
});
test('recreated volume cannot inherit the previous incarnation idle time', () => {
  const p = plan({ cs: [], kind: 'unknown', previous: record(now - 30 * day),
    vs: [{ ...volume(), CreatedAt: stamp(now) }] });
  assert.deepEqual(p.remove, []);
});
test('reuse refreshes the saved idle time before a later sweep', () => {
  const p = plan({ cs: [container('running')], previous: record(now - 30 * day) });
  assert.equal(p.state.volumes.data.idle_since, null);
  assert.deepEqual(plan({ cs: [], kind: 'unknown', previous: p.state, time: now + 30 * day }).remove, []);
});
test('lost state fails closed for unknown named volumes', () => {
  assert.deepEqual(plan({ cs: [], kind: 'unknown' }).remove, []);
});
test('out-of-scope projects retain records but schedule no operations', () => {
  const old = record(now - 30 * day);
  const p = plan({ scope: false, previous: old, age: 0 });
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.containers, []);
  assert.deepEqual(p.state, old);
});
test('anonymous orphans get an observation grace period and respect MIKE_GC_ONLY', () => {
  const v = volume('anon', { 'com.docker.compose.project': null, 'com.docker.volume.anonymous': '' });
  const first = plan({ cs: [], vs: [v], only: '' });
  assert.deepEqual(first.remove, []);
  assert.deepEqual(plan({ cs: [], vs: [v], only: '', previous: first.state, time: now + 8 * day }).remove, ['anon']);
  assert.deepEqual(plan({ cs: [], vs: [v], age: 0 }).remove, []);
});
test('Supabase orphan grace period respects the explicit allowlist', () => {
  const v = volume('data', { 'com.supabase.cli.project': project });
  const first = plan({ cs: [], vs: [v], kind: 'unknown', allowed: project });
  assert.deepEqual(first.remove, []);
  assert.deepEqual(plan({ cs: [], vs: [v], kind: 'unknown', allowed: project,
    previous: first.state, time: now + 8 * day }).remove, ['data']);
  assert.deepEqual(plan({ cs: [], vs: [v], kind: 'unknown', previous: first.state, age: 0 }).remove, []);
});
test('unparseable activity timestamps keep data conservatively', () => {
  const c = container('exited', now - 20 * day);
  c.State.FinishedAt = 'invalid';
  assert.deepEqual(plan({ cs: [c] }).remove, []);
});
