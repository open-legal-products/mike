// Registry-backed release recovery. build-<version> tags retain the original
// manifests; Actions artifacts and runner disks are not the release ledger.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const IMAGE_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];
const ACCEPT = [...IMAGE_TYPES, ...INDEX_TYPES].join(', ');
const IMAGES = ['backend', 'frontend'];
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export class Registry {
  constructor(repository, { actor, password, fetchImpl = fetch } = {}) {
    this.repository = repository;
    this.actor = actor;
    this.password = password;
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    if (!this.token) {
      const query = new URLSearchParams({ service: 'ghcr.io', scope: `repository:${this.repository}:pull,push` });
      const response = await this.fetch(`https://ghcr.io/token?${query}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${this.actor}:${this.password}`).toString('base64')}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Registry authentication failed (${response.status})`);
      this.token = (await response.json()).token;
      if (!this.token) throw new Error('Registry authentication returned no token');
    }
    return this.fetch(`https://ghcr.io/v2/${this.repository}/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, Accept: ACCEPT, ...options.headers },
      signal: AbortSignal.timeout(30_000),
    });
  }

  async manifest(ref) {
    const response = await this.request(`manifests/${ref}`);
    // A failed lookup is NOT permission to rebuild. Only a structured registry
    // "missing" response counts; auth errors, HTML 404s and outages fail closed.
    if (response.status === 404) {
      const body = await response.json();
      if (Array.isArray(body.errors) && body.errors.length > 0 &&
          body.errors.every(error => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error.code))) return null;
    }
    if (response.status !== 200) throw new Error(`Cannot inspect ${this.repository}:${ref} (${response.status})`);
    const raw = Buffer.from(await response.arrayBuffer());
    const digest = hash(raw);
    if (response.headers.get('docker-content-digest') !== digest ||
        (ref.startsWith('sha256:') && ref !== digest)) throw new Error(`Manifest digest mismatch for ${this.repository}:${ref}`);
    const document = JSON.parse(raw.toString());
    if (document.schemaVersion !== 2 || ![...IMAGE_TYPES, ...INDEX_TYPES].includes(document.mediaType)) {
      throw new Error(`Unsupported manifest for ${this.repository}:${ref}`);
    }
    return { raw, digest, document };
  }

  async identity(manifest) {
    let image = manifest;
    if (INDEX_TYPES.includes(image.document.mediaType)) {
      // Buildx includes attestation manifests in the index. Read the actual
      // linux/amd64 image config, not an attestation or an arbitrary platform.
      const platforms = image.document.manifests.filter(entry =>
        entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64');
      if (platforms.length !== 1) throw new Error(`Expected one linux/amd64 image in ${this.repository}`);
      image = await this.manifest(platforms[0].digest);
    }
    if (!image || !IMAGE_TYPES.includes(image.document.mediaType)) throw new Error(`Missing image manifest for ${this.repository}`);
    const digest = image.document.config.digest;
    const response = await this.request(`blobs/${digest}`);
    if (response.status !== 200) throw new Error(`Cannot read image identity for ${this.repository} (${response.status})`);
    const raw = Buffer.from(await response.arrayBuffer());
    if (hash(raw) !== digest) throw new Error(`Image config digest mismatch for ${this.repository}`);
    const config = JSON.parse(raw.toString());
    if (config.os !== 'linux' || config.architecture !== 'amd64') throw new Error(`Unexpected image platform for ${this.repository}`);
    return config.config?.Labels ?? {};
  }

  async tag(tag, manifest) {
    const response = await this.request(`manifests/${tag}`, {
      method: 'PUT', headers: { 'Content-Type': manifest.document.mediaType }, body: manifest.raw,
    });
    if (response.status !== 201 || response.headers.get('docker-content-digest') !== manifest.digest) {
      throw new Error(`Cannot publish ${this.repository}:${tag} (${response.status}); rerun to reconcile saved digests`);
    }
  }
}

export async function prepare(registries, { version, sha }) {
  const result = {};
  for (const image of IMAGES) {
    const registry = registries[image];
    const candidate = await registry.manifest(`build-${version}`);
    const released = await registry.manifest(version);
    if (!candidate && released) throw new Error(`${image}:${version} exists without its saved build; refusing to rebuild`);
    if (candidate) {
      const labels = await registry.identity(candidate);
      if (labels['org.opencontainers.image.version'] !== version || labels['org.opencontainers.image.revision'] !== sha) {
        throw new Error(`${image}:build-${version} belongs to a different version or commit; refusing to rebuild`);
      }
      if (released && released.digest !== candidate.digest) throw new Error(`${image}:${version} differs from its saved digest; refusing to overwrite`);
    }
    result[image] = { candidate, released };
  }
  return result;
}

export async function publish(registries, identity, tags) {
  // Check BOTH repositories before writing either immutable version tag.
  const plan = await prepare(registries, identity);
  if (IMAGES.some(image => !plan[image].candidate)) throw new Error('Both saved image builds are required before publication');
  if (tags.some(tag => ![identity.version, 'latest', 'main'].includes(tag))) throw new Error('Unexpected publication tag');
  for (const image of IMAGES) {
    if (!plan[image].released) await registries[image].tag(identity.version, plan[image].candidate);
  }
  // Floating tags are updated only once both immutable versions exist. The
  // workflow-wide concurrency group serializes this phase across every ref.
  // Registries cannot atomically tag two repositories: a failed PUT is repaired
  // by rerunning with these same retained manifests, without another build.
  for (const tag of tags.filter(tag => tag !== identity.version)) {
    for (const image of IMAGES) {
      const current = await registries[image].manifest(tag);
      if (current?.digest !== plan[image].candidate.digest) await registries[image].tag(tag, plan[image].candidate);
    }
  }
  return plan;
}

async function main() {
  const { OWNER: owner, VERSION: version, SHA: sha, GITHUB_ACTOR: actor, GH_TOKEN: password } = process.env;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner ?? '') ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || !actor || !password) throw new Error('Missing or invalid publication identity/credentials');
  const registries = Object.fromEntries(IMAGES.map(image => [image, new Registry(`${owner}/mike-${image}`, { actor, password })]));
  const identity = { version, sha };
  const command = process.argv[2];
  if (command === 'prepare') {
    const plan = await prepare(registries, identity);
    for (const image of IMAGES) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${image}_digest=${plan[image].candidate?.digest ?? ''}\n`);
      console.log(`${image}: ${plan[image].candidate ? 'reuse saved build' : 'confirmed missing; build required'}`);
    }
  } else if (command === 'publish') {
    const plan = await publish(registries, identity, (process.env.TAGS ?? '').split(/\s+/).filter(Boolean));
    mkdirSync('digests', { recursive: true });
    for (const image of IMAGES) {
      writeFileSync(`digests/${image}`, `${plan[image].candidate.digest}\n`);
      console.log(`${image}:${version} = ${plan[image].candidate.digest}`);
    }
  } else throw new Error('Expected prepare or publish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
