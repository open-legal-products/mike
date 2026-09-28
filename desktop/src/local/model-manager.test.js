const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createModelManager } = require("./model-manager");
const { MODEL, SMALL_MODEL, RUNTIME, OLLAMA_URL, chooseStarterModel } = require("./model-catalog");

// Exact official manifest bytes; changing whitespace changes the pinned digest.
const SMALL_MANIFEST = '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"mediaType":"application/vnd.docker.container.image.v1+json","digest":"sha256:ee043a99abe5e8317272712ed08ee2993af1f7930d69aefa3eba562cdc2822bd","size":473},"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:b709d81508a078a686961de6ca07a953b895d9b286c46e17f00fb267f4f2d297","size":2741180928},{"mediaType":"application/vnd.ollama.image.license","digest":"sha256:9be69ef463066202c1b1bd299aaf42bad370a01ba4b40d293617859720776c17","size":11354},{"mediaType":"application/vnd.ollama.image.params","digest":"sha256:9371364b27a52acac9d87f88bd93c9db1174d8d6ec57f6888925cdc1788871ff","size":65}]}';
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const syntheticResult = { done: true, response: JSON.stringify({ reference: "MIKE-42", date: "2026-01-15", amount: 7500 }), eval_count: 20, eval_duration: 1000000000 };

async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mike-model-test-"));
  const runtimeDir = path.join(temp, "runtime");
  const root = path.join(temp, "local");
  await fs.mkdir(runtimeDir);
  await fs.writeFile(path.join(runtimeDir, "ollama"), "test placeholder", { mode: 0o700 });
  await fs.writeFile(path.join(runtimeDir, "runtime.json"), JSON.stringify(RUNTIME));
  const calls = [], spawns = [], kills = [], states = [];
  let selectedModel = SMALL_MODEL;
  const behaviors = { tags: () => ({ models: [{ name: selectedModel.tag, digest: selectedModel.digest }] }),
    smoke: () => ({ done: true, response: "READY" }), benchmark: () => syntheticResult, pull: null };
  const dependencies = {
    runtimeDir, platform: "darwin", arch: "arm64", release: "25.0.0", memoryBytes: 8 * 1024 ** 3,
    statfs: async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 }),
    portAvailable: async () => true,
    pause: async () => {}, startupMs: 100,
    spawn: (executable, args, options) => {
      const child = new EventEmitter(); child.pid = 123; child.exitCode = null;
      spawns.push({ executable, args, options, child }); return child;
    },
    kill: (child, signal) => { kills.push(signal); child.exitCode = 0; child.emit("exit", 0); },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ url, ...options, body });
      if (url.endsWith("/api/version")) return json({ version: RUNTIME.version });
      if (url.endsWith("/api/tags")) return json(behaviors.tags());
      if (url.endsWith("/api/generate")) return json(body.format ? behaviors.benchmark() : behaviors.smoke());
      if (url.endsWith("/api/pull")) {
        if (behaviors.pull) return behaviors.pull(options.signal);
        const manifestDir = path.join(root, "models", "manifests", "registry.ollama.ai", "library", "qwen3.5");
        await fs.mkdir(manifestDir, { recursive: true });
        await fs.writeFile(path.join(manifestDir, "2b"), SMALL_MANIFEST);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          const line = JSON.stringify({ status: "pulling", digest: `sha256:${"b".repeat(64)}`, total: selectedModel.downloadBytes, completed: 1000 });
          controller.enqueue(encoder.encode(line.slice(0, 30)));
          controller.enqueue(encoder.encode(line.slice(30) + '\n{"status":"success"}'));
          controller.close();
        } }));
      }
      throw new Error("Unexpected request");
    },
    ...overrides,
  };
  selectedModel = chooseStarterModel(dependencies.memoryBytes);
  const app = { isPackaged: false, getPath: () => temp };
  const manager = createModelManager(app, { _dependencies: dependencies, onStatus: (state) => states.push(state) });
  t.after(async () => { await manager.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  return { manager, calls, spawns, kills, states, behaviors, root, temp, runtimeDir, app, dependencies };
}

test("selects the evaluated 2B starter for every supported Mac, regardless of memory", () => {
  for (const memoryGB of [8, 16, 32, 64, 128])
    assert.equal(chooseStarterModel(memoryGB * 1024 ** 3), SMALL_MODEL);
  for (const model of [SMALL_MODEL, MODEL])
    assert.equal(model.layers.reduce((bytes, layer) => bytes + layer.sizeBytes, 0), model.downloadBytes);
});

test("a fresh Mac with more memory still installs the 2B starter with its 8K context", async (t) => {
  const f = await fixture(t, { memoryBytes: 32 * 1024 ** 3 });
  const state = await f.manager.install();
  assert.equal(state.state, "ready");
  assert.equal(state.modelId, SMALL_MODEL.id);
  assert.equal(state.downloadBytes, SMALL_MODEL.downloadBytes);
  assert.equal(state.hardware.contextLength, 8192);
  assert.equal(f.spawns[0].options.env.OLLAMA_CONTEXT_LENGTH, "8192");
  assert.equal(f.calls.find((call) => call.url.endsWith("/api/pull")).body.model, SMALL_MODEL.tag);
});

test("checking a fresh install never starts a runtime or downloads weights", async (t) => {
  const f = await fixture(t);
  const state = await f.manager.status();
  assert.equal(state.state, "not-installed");
  assert.equal(state.modelId, SMALL_MODEL.id);
  assert.equal(state.downloadBytes, 2741192820);
  assert.equal(state.hardware.supported, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns.length, 0);
  state.hardware.supported = false;
  assert.equal((await f.manager.status()).hardware.supported, true);
});

test("caps context for a retained 4B model by current physical memory", async (t) => {
  for (const [memoryGB, expectedContext] of [[8, 8192], [16, 16384]]) {
    const f = await fixture(t, { memoryBytes: memoryGB * 1024 ** 3 });
    await fs.mkdir(f.root, { recursive: true });
    await fs.writeFile(path.join(f.root, "local-model.json"), JSON.stringify({
      version: 1, modelId: MODEL.id, manifestDigest: null,
    }));
    f.behaviors.tags = () => ({ models: [{ name: MODEL.tag, digest: MODEL.digest }] });
    const state = await f.manager.install();
    assert.equal(state.state, "ready");
    assert.equal(state.modelId, MODEL.id);
    assert.equal(f.calls.find((call) => call.url.endsWith("/api/pull")).body.model, MODEL.tag);
    assert.equal(state.hardware.contextLength, expectedContext);
    assert.equal(f.spawns[0].options.env.OLLAMA_CONTEXT_LENGTH, String(expectedContext));
    const smoke = f.calls.find((call) => call.url.endsWith("/api/generate"));
    assert.equal(smoke.body.options.num_ctx, expectedContext);
  }
});

test("unsupported hardware and insufficient disk space fail before spawning", async (t) => {
  const unsupported = await fixture(t, { arch: "x64" });
  assert.match((await unsupported.manager.install()).error, /Apple Silicon/);
  assert.equal(unsupported.spawns.length, 0);
  const space = await fixture(t, { statfs: async () => ({ bavail: 100, bsize: 1 }) });
  assert.match((await space.manager.install()).error, /free disk space/);
  assert.equal(space.spawns.length, 0);
});

test("retries a nearly complete download with only the remaining space plus reserve available", async (t) => {
  let available = 20 * 1024 ** 3;
  let retained = 0;
  let partial;
  const layer = SMALL_MODEL.layers[0];
  const f = await fixture(t, {
    statfs: async () => ({ bavail: available, bsize: 1 }),
    lstat: async (file) => file === partial
      ? { isFile: () => true, size: layer.sizeBytes, blocks: retained / 512 }
      : fs.lstat(file),
  });
  const blobs = path.join(f.root, "models", "blobs");
  await fs.mkdir(blobs, { recursive: true });
  partial = path.join(blobs, `sha256-${layer.digest}-partial`);
  f.behaviors.pull = () => {
    retained = Math.floor(2600000000 / 512) * 512;
    available = 1500000000;
    return new Response('{"error":"interrupted"}\n');
  };
  assert.equal((await f.manager.install()).state, "error");
  assert.ok(available < SMALL_MODEL.downloadBytes + SMALL_MODEL.diskReserveBytes);
  f.behaviors.pull = null;
  const resumed = await f.manager.install();
  assert.equal(resumed.state, "ready");
  assert.equal(resumed.hardware.remainingDownloadBytes, SMALL_MODEL.downloadBytes - retained);
  assert.ok(resumed.hardware.requiredFreeDiskBytes < available);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/api/pull")).length, 2);
});

test("does not mistake a preallocated sparse partial file for downloaded data", async (t) => {
  const f = await fixture(t, { statfs: async () => ({ bavail: 1500000000, bsize: 1 }) });
  const blobs = path.join(f.root, "models", "blobs");
  await fs.mkdir(blobs, { recursive: true });
  const partial = await fs.open(path.join(blobs, `sha256-${SMALL_MODEL.layers[0].digest}-partial`), "w");
  try { await partial.truncate(SMALL_MODEL.layers[0].sizeBytes); } finally { await partial.close(); }
  const state = await f.manager.install();
  assert.equal(state.state, "error");
  assert.match(state.error, /free disk space/);
  assert.equal(f.spawns.length, 0);
});

test("never counts a completed and partial copy of the same layer twice", async (t) => {
  let blob;
  const retained = Math.floor(2600000000 / 512) * 512;
  const f = await fixture(t, { lstat: async (file) => file === blob || file === `${blob}-partial`
    ? { isFile: () => true, size: SMALL_MODEL.layers[0].sizeBytes, blocks: retained / 512 }
    : fs.lstat(file) });
  const blobs = path.join(f.root, "models", "blobs");
  await fs.mkdir(blobs, { recursive: true });
  blob = path.join(blobs, `sha256-${SMALL_MODEL.layers[0].digest}`);
  const state = await f.manager.status();
  assert.equal(state.hardware.remainingDownloadBytes, SMALL_MODEL.downloadBytes - retained);
});

test("ignores symlinked blobs when checking remaining space", async (t) => {
  const f = await fixture(t);
  const blobs = path.join(f.root, "models", "blobs");
  await fs.mkdir(blobs, { recursive: true });
  const otherFile = path.join(f.temp, "unrelated-file");
  await fs.writeFile(otherFile, "unrelated data");
  await fs.symlink(otherFile, path.join(blobs, `sha256-${SMALL_MODEL.layers[0].digest}-partial`));
  assert.equal((await f.manager.status()).hardware.remainingDownloadBytes, SMALL_MODEL.downloadBytes);
});

test("refuses an occupied port without using or killing that daemon", async (t) => {
  const f = await fixture(t, { portAvailable: async () => false });
  assert.match((await f.manager.install()).error, /using Mike's local AI port/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.kills.length, 0);
});

test("requires the pinned bundled runtime before starting", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.runtimeDir, "runtime.json"), JSON.stringify({ version: "old" }));
  assert.match((await f.manager.install()).error, /runtime is missing/);
  assert.equal(f.spawns.length, 0);
});

test("downloads only its approved model and marks ready only after digest and inference checks", async (t) => {
  const f = await fixture(t);
  const ready = await f.manager.install({ url: "https://untrusted.example/model" });
  assert.equal(ready.state, "ready");
  assert.equal(ready.progress, 1);
  assert.ok(f.states.some((state) => state.completedBytes === 1000));
  assert.ok(f.states.some((state) => state.state === "verifying"));
  const pull = f.calls.find((call) => call.url.endsWith("/api/pull"));
  assert.deepEqual(pull.body, { model: SMALL_MODEL.tag, stream: true });
  assert.ok(f.calls.every((call) => call.url.startsWith(OLLAMA_URL)));
  const spawned = f.spawns[0];
  assert.deepEqual(spawned.args, ["serve"]);
  assert.equal(spawned.options.env.OLLAMA_HOST, "127.0.0.1:42816");
  assert.equal(spawned.options.env.OLLAMA_NO_CLOUD, "1");
  assert.equal(spawned.options.env.OLLAMA_DEBUG_LOG_REQUESTS, "0");
  assert.equal(spawned.options.env.OLLAMA_NUM_PARALLEL, "1");
  assert.equal(spawned.options.env.OLLAMA_CONTEXT_LENGTH, "8192");
  assert.equal(spawned.options.env.OLLAMA_MODELS, path.join(f.root, "models"));
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "local-model.json"), "utf8"));
  assert.equal(saved.manifestDigest, SMALL_MODEL.digest);
  assert.equal(saved.modelId, SMALL_MODEL.id);
  await f.manager.install();
  assert.equal(f.calls.filter((call) => call.url.endsWith("/api/pull")).length, 1);
});

test("does not accept a changed registry tag or leak provider errors", async (t) => {
  const f = await fixture(t);
  f.behaviors.tags = () => ({ models: [{ name: SMALL_MODEL.tag, digest: "changed" }] });
  const result = await f.manager.install();
  assert.equal(result.state, "error");
  assert.match(result.error, /approved model/);
  assert.equal(f.calls.some((call) => call.url.endsWith("/api/generate")), false);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "local-model.json"), "utf8"));
  assert.equal(saved.manifestDigest, null);
  assert.deepEqual(f.kills, ["SIGTERM"]);
});

test("a failed smoke request can be retried using the same retained model directory", async (t) => {
  const f = await fixture(t);
  f.behaviors.smoke = () => ({ done: true, response: "" });
  assert.equal((await f.manager.install()).state, "error");
  f.behaviors.smoke = () => ({ done: true, response: "READY" });
  assert.equal((await f.manager.install()).state, "ready");
  assert.equal(f.spawns.length, 2);
  assert.equal(f.spawns[0].options.env.OLLAMA_MODELS, f.spawns[1].options.env.OLLAMA_MODELS);
});

test("cancel aborts an in-flight pull, stops only the owned child and permits retry", async (t) => {
  const f = await fixture(t);
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  f.behaviors.pull = (signal) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    began();
  } }));
  const installing = f.manager.install();
  await started;
  assert.equal((await f.manager.cancel()).state, "cancelled");
  assert.equal((await installing).state, "cancelled");
  assert.deepEqual(f.kills, ["SIGTERM"]);
  f.behaviors.pull = null;
  assert.equal((await f.manager.install()).state, "ready");
});

test("a stalled pull times out without exposing raw download error content", async (t) => {
  const f = await fixture(t, { downloadStallMs: 10 });
  f.behaviors.pull = (signal) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener("abort", () => controller.error(new Error("private signed URL secret")), { once: true });
  } }));
  const result = await f.manager.install();
  assert.equal(result.state, "error");
  assert.match(result.error, /download could not finish/);
  assert.doesNotMatch(result.error, /secret/);
});

test("rejects malformed or oversized progress streams and unfinished downloads", async (t) => {
  for (const body of ["not JSON\n", "x".repeat(65537), '{"status":"pulling"}\n', '{"error":"SECRET"}\n']) {
    const f = await fixture(t);
    f.behaviors.pull = () => new Response(body);
    const result = await f.manager.install();
    assert.equal(result.state, "error");
    assert.doesNotMatch(result.error, /SECRET/);
  }
});

test("measures a bounded synthetic check and stores metrics without prompt/response text", async (t) => {
  const f = await fixture(t);
  await f.manager.install();
  const result = await f.manager.benchmark();
  assert.equal(result.state, "ready");
  assert.equal(result.benchmark.passed, true);
  assert.equal(result.benchmark.tokensPerSecond, 20);
  assert.equal(result.benchmark.totalChecks, 3);
  assert.ok(result.benchmark.latencyMs >= 0);
  const saved = await fs.readFile(path.join(f.root, "local-model.json"), "utf8");
  assert.doesNotMatch(saved, /MIKE-42|2026-01-15|7500|fabricated contract/);
  assert.match(saved, /Synthetic extraction smoke check/);
  f.behaviors.benchmark = () => ({ ...syntheticResult, response: '{"reference":"wrong"}' });
  const failedCheck = await f.manager.benchmark();
  assert.equal(failedCheck.state, "ready");
  assert.equal(failedCheck.benchmark.passed, false);
  assert.deepEqual(failedCheck.benchmark.checks.map((check) => check.passed), [false, false, false]);
});

test("returning installs preserve their chosen model and start without another pull", async (t) => {
  const f = await fixture(t);
  await f.manager.install();
  await f.manager.stop();
  const count = f.calls.length;
  const returning = createModelManager(f.app, { _dependencies: { ...f.dependencies, memoryBytes: 32 * 1024 ** 3 } });
  t.after(() => returning.stop());
  const state = await returning.status();
  assert.equal(state.modelId, SMALL_MODEL.id);
  assert.equal(state.state, "ready");
  assert.equal(f.calls.slice(count).some((call) => call.url.endsWith("/api/pull")), false);
});

test("a corrupted local manifest does not start a runtime on status", async (t) => {
  const f = await fixture(t);
  await f.manager.install();
  await f.manager.stop();
  await fs.writeFile(path.join(f.root, "models", "manifests", "registry.ollama.ai", "library", "qwen3.5", "2b"), "corrupt");
  const count = f.spawns.length;
  const returning = createModelManager(f.app, { _dependencies: f.dependencies });
  t.after(() => returning.stop());
  assert.equal((await returning.status()).state, "not-installed");
  assert.equal(f.spawns.length, count);
});

test("a stopped runtime never reports ready and restarts its verified cache without another pull", async (t) => {
  const f = await fixture(t);
  await f.manager.install();
  await f.manager.stop();
  assert.equal((await f.manager.status()).state, "error");
  const priorPulls = f.calls.filter((call) => call.url.endsWith("/api/pull")).length;
  assert.equal((await f.manager.install()).state, "ready");
  assert.equal(f.calls.filter((call) => call.url.endsWith("/api/pull")).length, priorPulls);
});

test("an owned child exiting during startup never produces readiness", async (t) => {
  const f = await fixture(t, { spawn: () => {
    const child = new EventEmitter(); child.exitCode = null;
    queueMicrotask(() => { child.exitCode = 1; child.emit("exit", 1); }); return child;
  } });
  const result = await f.manager.install();
  assert.equal(result.state, "error");
  assert.equal(f.calls.some((call) => call.url.endsWith("/api/pull")), false);
});
