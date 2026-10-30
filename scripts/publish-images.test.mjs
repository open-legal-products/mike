import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry, prepare, publish } from './publish-images.mjs';

const version = '2.1.0';
const sha = 'a'.repeat(40);
const identity = { version, sha };
const hash = raw => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
const IMAGE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const missing = () => new Response(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }), { status: 404 });

// Exercise the actual Registry client and publish logic against the registry
// protocol, including Buildx indexes/attestations and failed/ambiguous PUTs.
function fixture() {
  const repos = Object.fromEntries(['backend', 'frontend'].map(image => [image, { manifests: new Map(), blobs: new Map() }]));
  const writes = [];
  const faults = new Map();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/token') {
      const fault = faults.get('token');
      if (fault) return fault();
      assert.match(options.headers.Authorization, /^Basic /);
      return Response.json({ token: 'test-token' });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const [, image, kind, ref] = parsed.pathname.match(/^\/v2\/test\/mike-(backend|frontend)\/(manifests|blobs)\/(.+)$/);
    const method = options.method ?? 'GET';
    const fault = faults.get(`${method} ${image} ${kind} ${ref}`);
    if (fault) return fault(options);
    const store = repos[image][kind];
    if (method === 'PUT') {
      const raw = Buffer.from(options.body);
      writes.push(`${image}:${ref}`);
      store.set(ref, raw);
      store.set(hash(raw), raw);
      return new Response(null, { status: 201, headers: { 'docker-content-digest': hash(raw) } });
    }
    const raw = store.get(ref);
    return raw ? new Response(raw, { headers: { 'docker-content-digest': hash(raw) } }) : missing();
  };
  const registries = Object.fromEntries(['backend', 'frontend'].map(image => [image, new Registry(`test/mike-${image}`, {
    actor: 'test', password: 'synthetic', fetchImpl,
  })]));
  function build(image, { revision = sha, imageVersion = version, index = true } = {}) {
    const repo = repos[image];
    const config = Buffer.from(JSON.stringify({
      os: 'linux', architecture: 'amd64', config: { Labels: {
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': imageVersion,
        'test.image': image,
      } },
    }));
    repo.blobs.set(hash(config), config);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: IMAGE, config: { digest: hash(config) }, layers: [] }));
    repo.manifests.set(hash(manifest), manifest);
    const raw = index ? Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: INDEX, manifests: [
      { digest: hash(manifest), mediaType: IMAGE, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: `sha256:${'0'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ] })) : manifest;
    repo.manifests.set(hash(raw), raw);
    repo.manifests.set(`build-${version}`, raw);
    return hash(raw);
  }
  const digest = (image, ref) => {
    const raw = repos[image].manifests.get(ref);
    return raw && hash(raw);
  };
  return { repos, writes, faults, registries, build, digest };
}

test('only confirmed absent images are marked for building; already pushed candidates are reused', async () => {
  const f = fixture();
  assert.equal((await prepare(f.registries, identity)).backend.candidate, null);
  const original = f.build('backend');
  const plan = await prepare(f.registries, identity);
  assert.equal(plan.backend.candidate.digest, original);
  assert.equal(plan.frontend.candidate, null);
  assert.deepEqual(f.writes, []);
});

test('publishes both immutable versions before floating tags, retaining the exact index digests', async () => {
  const f = fixture();
  const backend = f.build('backend');
  const frontend = f.build('frontend', { index: false });
  await publish(f.registries, identity, [version, 'latest']);
  assert.deepEqual(f.writes, [`backend:${version}`, `frontend:${version}`, 'backend:latest', 'frontend:latest']);
  for (const tag of [version, 'latest', `build-${version}`]) {
    assert.equal(f.digest('backend', tag), backend);
    assert.equal(f.digest('frontend', tag), frontend);
  }
  f.writes.length = 0;
  await publish(f.registries, identity, [version, 'latest']);
  assert.deepEqual(f.writes, [], 'completed retries accept matching tags without rewriting them');
});

for (const failedTag of [version, 'latest']) {
  test(`recovers a failed frontend ${failedTag} write on a full rerun without rebuilding`, async () => {
    const f = fixture();
    const backend = f.build('backend');
    const frontend = f.build('frontend');
    const key = `PUT frontend manifests ${failedTag}`;
    f.faults.set(key, () => new Response('registry unavailable', { status: 503 }));
    await assert.rejects(publish(f.registries, identity, [version, 'latest']), /Cannot publish/);
    assert.equal(f.digest('backend', version), backend);
    // Simulate a fresh workflow, with no Actions artifacts or runner files.
    // prepare is called both in identity AND again in each retried build job.
    const resumed = await prepare(f.registries, identity);
    assert.equal(resumed.backend.candidate.digest, backend);
    assert.equal(resumed.frontend.candidate.digest, frontend);
    f.faults.delete(key);
    f.writes.length = 0;
    await publish(f.registries, identity, [version, 'latest']);
    assert(!f.writes.includes(`backend:${version}`));
    assert.equal(f.digest('backend', 'latest'), backend);
    assert.equal(f.digest('frontend', 'latest'), frontend);
  });
}

test('recovers a successful registry write whose response was lost', async () => {
  const f = fixture();
  const backend = f.build('backend');
  f.build('frontend');
  const key = `PUT backend manifests ${version}`;
  f.faults.set(key, options => {
    f.repos.backend.manifests.set(version, Buffer.from(options.body));
    throw new Error('connection reset after PUT');
  });
  await assert.rejects(publish(f.registries, identity, [version]), /connection reset/);
  f.faults.delete(key);
  await publish(f.registries, identity, [version]);
  assert.equal(f.digest('backend', version), backend);
  assert.deepEqual(f.writes, [`frontend:${version}`]);
});

test('refuses a released image without its saved build instead of rebuilding', async () => {
  const f = fixture();
  f.build('backend');
  f.repos.backend.manifests.set(version, f.repos.backend.manifests.get(`build-${version}`));
  f.repos.backend.manifests.delete(`build-${version}`);
  await assert.rejects(prepare(f.registries, identity), /exists without its saved build/);
  assert.deepEqual(f.writes, []);
});

for (const invalid of [{ revision: 'b'.repeat(40) }, { imageVersion: '2.0.0' }]) {
  test(`rejects saved builds with conflicting identity ${JSON.stringify(invalid)}`, async () => {
    const f = fixture();
    f.build('backend', invalid);
    await assert.rejects(prepare(f.registries, identity), /different version or commit/);
  });
}

test('preflights both repositories before writing any immutable tags', async () => {
  const f = fixture();
  f.build('backend');
  f.build('frontend', { revision: 'b'.repeat(40) });
  f.repos.frontend.manifests.set(version, f.repos.frontend.manifests.get(`build-${version}`));
  f.build('frontend');
  await assert.rejects(publish(f.registries, identity, [version]), /differs from its saved digest/);
  assert.deepEqual(f.writes, []);
});

test('does not publish when either build is missing', async () => {
  const f = fixture();
  f.build('backend');
  await assert.rejects(publish(f.registries, identity, [version]), /Both saved image builds/);
  assert.deepEqual(f.writes, []);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`fails closed on registry lookup HTTP ${status}`, async () => {
    const f = fixture();
    f.build('backend');
    f.faults.set(`GET backend manifests ${version}`, () => new Response('registry failure', { status }));
    await assert.rejects(prepare(f.registries, identity), /Cannot inspect/);
    assert.deepEqual(f.writes, []);
  });
}

for (const body of ['<html>not found</html>', '{}', '{"errors":[{"code":"DENIED"}]}', '{"errors":[]}']) {
  test(`does not treat an unconfirmed 404 as a missing image: ${body}`, async () => {
    const f = fixture();
    f.faults.set(`GET backend manifests build-${version}`, () => new Response(body, { status: 404 }));
    await assert.rejects(prepare(f.registries, identity));
  });
}

test('fails closed on a network error even when the release already exists', async () => {
  const f = fixture();
  f.build('backend');
  f.build('frontend');
  await publish(f.registries, identity, [version]);
  f.faults.set(`GET backend manifests ${version}`, () => { throw new Error('connection failure'); });
  await assert.rejects(prepare(f.registries, identity), /connection failure/);
  f.faults.clear();
  f.writes.length = 0;
  await publish(f.registries, identity, [version]);
  assert.deepEqual(f.writes, []);
});

test('authentication failures stop before registry lookups', async () => {
  const f = fixture();
  f.faults.set('token', () => new Response('denied', { status: 403 }));
  await assert.rejects(prepare(f.registries, identity), /authentication failed/);
});

test('rejects corrupt manifests and config blobs', async () => {
  const f = fixture();
  f.build('backend');
  f.faults.set(`GET backend manifests build-${version}`, () => new Response('{}', {
    headers: { 'docker-content-digest': `sha256:${'0'.repeat(64)}` },
  }));
  await assert.rejects(prepare(f.registries, identity), /Manifest digest mismatch/);
  f.faults.clear();
  for (const digest of f.repos.backend.blobs.keys()) f.repos.backend.blobs.set(digest, Buffer.from('{}'));
  await assert.rejects(prepare(f.registries, identity), /config digest mismatch/);
});
