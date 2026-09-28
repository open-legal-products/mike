// Owns the optional local model. Only Electron main imports this module;
// renderers can request fixed operations, never URLs, model tags or paths.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { stackPaths, dataPaths } = require("./config");
const { MODELS, chooseStarterModel, RUNTIME, OLLAMA_URL } = require("./model-catalog");

const MESSAGES = {
  hardware: "Local AI requires an Apple Silicon Mac with macOS 14 or newer and at least 8 GB of memory. You can continue without a local model.",
  space: "There is not enough free disk space to download this model. Free some space and try again.",
  runtime: "The local AI runtime is missing or unavailable. Install the complete Mike Mac app and try again.",
  port: "Another application is using Mike's local AI port. Close the other Mike instance and try again.",
  startup: "The local AI runtime could not start. Restart Mike and try again.",
  stopped: "The local AI runtime stopped. Try again or restart Mike.",
  download: "The model download could not finish. Check your connection and try again; downloaded parts will be reused.",
  timeout: "The local model took too long to respond. Close other memory-intensive apps and try again.",
  digest: "The downloaded model does not match this version of Mike's approved model. Update Mike before trying again.",
  verify: "The model downloaded but could not answer a test request. Close other memory-intensive apps and try again.",
  benchmark: "The local performance check could not finish. Try again when your Mac is less busy.",
  storage: "Mike could not save the local model's status. Check available disk space and try again.",
};
class ModelError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portAvailable() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port: 42816, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function readSmallJson(file) {
  const stat = await fsp.stat(file);
  if (stat.size > 64 * 1024) throw new Error("invalid state");
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function safeBenchmark(value) {
  if (!value || value.label !== "Synthetic extraction smoke check" || !Array.isArray(value.checks)
    || value.checks.length !== 3 || !Number.isFinite(value.latencyMs)
    || value.latencyMs < 0 || value.latencyMs > 3600000
    || !(value.tokensPerSecond === null || (Number.isFinite(value.tokensPerSecond)
      && value.tokensPerSecond >= 0 && value.tokensPerSecond < 1000000))
    || !Number.isFinite(Date.parse(value.recordedAt))) return null;
  const names = ["Reference", "Date", "Amount"];
  const checks = names.map((name, i) => ({ name, passed: value.checks[i]?.passed === true }));
  return { label: value.label, passed: checks.every((check) => check.passed), checks,
    totalChecks: 3, latencyMs: value.latencyMs, tokensPerSecond: value.tokensPerSecond,
    recordedAt: new Date(value.recordedAt).toISOString() };
}

function createModelManager(app, { onStatus = () => {}, _dependencies = {} } = {}) {
  // The dependency seam is exclusively for Node tests, never forwarded over IPC.
  const deps = { fetch: globalThis.fetch, spawn, portAvailable, pause,
    platform: process.platform, arch: process.arch, release: os.release(),
    // Metal discovery on a cold M1 took 23 seconds in the native smoke test.
    memoryBytes: os.totalmem(), statfs: fsp.statfs, lstat: fsp.lstat, startupMs: 90000,
    requestMs: 180000, downloadStallMs: 90000, downloadMs: 2 * 60 * 60 * 1000,
    ..._dependencies };
  let MODEL = chooseStarterModel();
  const root = dataPaths(app).root;
  const modelsDir = path.join(root, "models");
  const stateFile = path.join(root, "local-model.json");
  const runtimeDir = deps.runtimeDir || path.join(stackPaths(app).bin, "ollama");
  const executable = path.join(runtimeDir, "ollama");
  const manifestFile = () => path.join(modelsDir, "manifests", "registry.ollama.ai", "library", "qwen3.5", MODEL.tag.split(":")[1]);
  let child = null;
  let childStopping = false;
  let operation = null;
  let initialization = null;
  let verified = false;
  let stopped = false;
  let lastEmission = 0;
  let snapshot = { state: "not-installed", modelId: MODEL.id, modelName: MODEL.name,
    downloadBytes: MODEL.downloadBytes, completedBytes: 0, progress: 0,
    error: null, hardware: null, benchmark: null };

  function view() {
    // A stopped manager may be inspected before a new window is created. Never
    // report inference readiness merely because the weights remain installed.
    const current = snapshot.state === "ready" && !child
      ? { ...snapshot, state: "error", error: MESSAGES.stopped } : snapshot;
    return structuredClone(current);
  }
  function update(changes, throttle = false) {
    snapshot = { ...snapshot, ...changes };
    if (throttle && Date.now() - lastEmission < 100) return;
    lastEmission = Date.now();
    // A destroyed renderer must not break an otherwise successful download.
    try { onStatus(view()); } catch { /* listener lifetime belongs to main */ }
  }
  function checkAbort(signal) { if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError"); }
  // A retained model choice may move to a Mac with less memory. Context must
  // follow the current device, independently of which reviewed model it uses.
  const contextLength = () => Math.min(MODEL.contextLength,
    deps.memoryBytes >= 16 * 1024 ** 3 ? 16384 : 8192);

  async function remainingDownloadBytes() {
    const blobsDir = path.join(modelsDir, "blobs");
    // Credit only files in this manager's model directory. Do not follow
    // directory or file symlinks when estimating retained download space.
    try {
      if (!(await deps.lstat(modelsDir)).isDirectory() || !(await deps.lstat(blobsDir)).isDirectory())
        return MODEL.downloadBytes;
    } catch { return MODEL.downloadBytes; }
    let retainedBytes = 0;
    for (const layer of MODEL.layers) {
      let allocated = 0;
      for (const suffix of ["", "-partial"]) {
        try {
          const stat = await deps.lstat(path.join(blobsDir, `sha256-${layer.digest}${suffix}`));
          if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0
            || stat.size > layer.sizeBytes || !Number.isSafeInteger(stat.blocks) || stat.blocks < 0) continue;
          // Ollama truncates a sparse partial file to its full intended size
          // before receiving bytes. st_blocks measures actual allocation in
          // 512-byte units; logical size would over-credit untouched holes.
          // A completed and partial copy are the same layer, never added twice.
          allocated = Math.max(allocated, Math.min(layer.sizeBytes, stat.size, stat.blocks * 512));
        } catch { /* missing or unreadable files contribute no retained space */ }
      }
      retainedBytes += allocated;
    }
    return Math.max(0, MODEL.downloadBytes - retainedBytes);
  }

  async function hardware() {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    let freeDiskBytes = null;
    try { const stat = await deps.statfs(root); freeDiskBytes = Number(stat.bavail) * Number(stat.bsize); } catch { /* display unavailable, preflight fails closed */ }
    const supported = deps.platform === "darwin" && deps.arch === "arm64"
      && Number.parseInt(deps.release, 10) >= 23 && deps.memoryBytes >= MODEL.minimumMemoryBytes;
    const recommendation = !supported ? MESSAGES.hardware
      : deps.memoryBytes < MODEL.recommendedMemoryBytes
        ? "16 GB of memory is recommended. On this Mac, close other apps and expect slower responses."
        : MODEL.tag.endsWith(":2b")
          ? "The 2B starter model is selected. Start with basic drafting and extraction; check its work and measure performance locally."
          : "Your existing 4B model selection is retained. Performance is measured locally after download.";
    const remainingBytes = await remainingDownloadBytes();
    return { platform: deps.platform, arch: deps.arch, memoryBytes: deps.memoryBytes,
      freeDiskBytes, remainingDownloadBytes: remainingBytes,
      requiredFreeDiskBytes: remainingBytes + MODEL.diskReserveBytes,
      contextLength: contextLength(), supported, recommendation };
  }

  async function ownedManifestMatches() {
    try {
      if ((await fsp.stat(manifestFile())).size > 64 * 1024) return false;
      return createHash("sha256").update(await fsp.readFile(manifestFile())).digest("hex") === MODEL.digest;
    } catch { return false; }
  }

  async function save() {
    const tmp = `${stateFile}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, modelId: MODEL.id, manifestDigest: verified ? MODEL.digest : null,
        benchmark: snapshot.benchmark }) + "\n", { mode: 0o600 });
      await fsp.rename(tmp, stateFile);
    } catch { throw new ModelError("storage"); }
  }

  async function stopRuntime() {
    const owned = child;
    if (!owned) return;
    childStopping = true;
    const exit = new Promise((resolve) => owned.once("exit", resolve));
    const kill = (signal) => {
      if (owned.exitCode !== null && owned.exitCode !== undefined) return;
      try {
        if (deps.kill) deps.kill(owned, signal);
        else if (owned.pid) process.kill(-owned.pid, signal); // dedicated process group, including model runners
      } catch { try { owned.kill(signal); } catch { /* already exited */ } }
    };
    kill("SIGTERM");
    await Promise.race([exit, deps.pause(3000)]);
    if (child === owned) { kill("SIGKILL"); child = null; }
    childStopping = false;
  }

  async function jsonRequest(endpoint, body, signal, timeoutMs = deps.requestMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ModelError("timeout")), timeoutMs);
    try {
      checkAbort(signal);
      const response = await deps.fetch(`${OLLAMA_URL}${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new ModelError("verify");
      if (!response.body) throw new ModelError("verify");
      let text = "";
      const decoder = new TextDecoder();
      for await (const part of response.body) {
        text += decoder.decode(part, { stream: true });
        if (text.length > 128 * 1024) throw new ModelError("verify");
      }
      text += decoder.decode();
      return JSON.parse(text);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async function startRuntime(signal) {
    if (child) return;
    checkAbort(signal);
    try {
      await fsp.access(executable, fs.constants.X_OK);
      const stamp = await readSmallJson(path.join(runtimeDir, "runtime.json"));
      if (stamp.version !== RUNTIME.version || stamp.sha256 !== RUNTIME.sha256) throw new Error("runtime pin");
    } catch { throw new ModelError("runtime"); }
    if (!(await deps.portAvailable())) throw new ModelError("port");
    checkAbort(signal);
    await fsp.mkdir(modelsDir, { recursive: true, mode: 0o700 });
    const env = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "HTTPS_PROXY", "https_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { OLLAMA_HOST: "127.0.0.1:42816", OLLAMA_MODELS: modelsDir,
      OLLAMA_NO_CLOUD: "1", OLLAMA_DEBUG: "0", OLLAMA_DEBUG_LOG_REQUESTS: "0",
      OLLAMA_NOHISTORY: "1", OLLAMA_CONTEXT_LENGTH: String(contextLength()),
      OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_KEEP_ALIVE: "5m" });
    update({ state: "starting", error: null });
    let launchFailed = false;
    const owned = deps.spawn(executable, ["serve"], { cwd: runtimeDir, env, detached: true, stdio: "ignore" });
    child = owned;
    owned.once("error", () => { launchFailed = true; });
    owned.once("exit", () => {
      if (child === owned) child = null;
      if (!childStopping && !stopped) {
        launchFailed = true;
        operation?.controller.abort(new ModelError("stopped"));
        update({ state: "error", error: MESSAGES.stopped });
      }
    });
    const deadline = Date.now() + deps.startupMs;
    while (Date.now() < deadline) {
      checkAbort(signal);
      if (launchFailed || child !== owned) throw new ModelError("startup");
      try {
        const version = await jsonRequest("/api/version", undefined, signal, 1000);
        // Let an address-in-use exit arrive before accepting the health result.
        await deps.pause(100);
        if (version.version === RUNTIME.version && child === owned && !launchFailed) return;
      } catch { checkAbort(signal); }
      await deps.pause(150);
    }
    throw new ModelError("startup");
  }

  async function verifyModel(signal, smoke = true) {
    const tags = await jsonRequest("/api/tags", undefined, signal);
    const installed = tags.models?.find((model) => model.name === MODEL.tag || model.model === MODEL.tag);
    if (installed?.digest !== MODEL.digest) throw new ModelError("digest");
    if (!smoke) return;
    update({ state: "verifying", error: null });
    const result = await jsonRequest("/api/generate", { model: MODEL.tag,
      prompt: "Reply with the single word READY.", stream: false, think: false,
      options: { num_ctx: contextLength(), num_predict: 16, temperature: 0 } }, signal);
    if (result.done !== true || typeof result.response !== "string" || !result.response.trim()) throw new ModelError("verify");
  }

  function run(kind, task) {
    if (operation) return operation.promise;
    if (kind !== "restore") stopped = false;
    const current = { kind, controller: new AbortController(), promise: null };
    operation = current;
    current.promise = (async () => {
      try { await task(current.controller.signal); }
      catch (error) {
        if (current.controller.signal.aborted && !(current.controller.signal.reason instanceof ModelError)) {
          update({ state: "cancelled", error: null });
        } else {
          const failure = current.controller.signal.reason instanceof ModelError ? current.controller.signal.reason : error;
          update({ state: "error", error: failure instanceof ModelError ? failure.message
            : MESSAGES[kind === "install" ? "download" : kind === "benchmark" ? "benchmark" : "startup"] });
        }
        await stopRuntime();
      } finally { if (operation === current) operation = null; }
      return view();
    })();
    return current.promise;
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      let saved;
      try { saved = await readSmallJson(stateFile); } catch { /* first launch */ }
      MODEL = MODELS.find((model) => model.id === saved?.modelId) || MODEL;
      update({ modelId: MODEL.id, modelName: MODEL.name, downloadBytes: MODEL.downloadBytes, hardware: await hardware() });
      if (!saved) return;
      snapshot.benchmark = safeBenchmark(saved.benchmark);
      if (saved.manifestDigest !== MODEL.digest || !(await ownedManifestMatches())) return;
      verified = true;
      if (!snapshot.hardware.supported || stopped) return;
      await run("restore", async (signal) => {
        await startRuntime(signal);
        await verifyModel(signal);
        checkAbort(signal);
        update({ state: "ready", completedBytes: MODEL.downloadBytes, progress: 1, error: null });
      });
    })().catch(() => { update({ state: "error", error: MESSAGES.storage }); });
    return initialization;
  }

  async function pull(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let stall;
    const resetStall = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new ModelError("download")), deps.downloadStallMs); };
    const totalTimer = setTimeout(() => controller.abort(new ModelError("download")), deps.downloadMs);
    let success = false;
    const layers = new Map();
    const accept = (line) => {
      if (!line.trim()) return;
      const part = JSON.parse(line);
      if (part.error) throw new ModelError("download");
      if (part.status === "success") success = true;
      if (typeof part.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(part.digest)
        && Number.isFinite(part.total) && part.total >= 0 && part.total <= MODEL.downloadBytes
        && Number.isFinite(part.completed) && part.completed >= 0) {
        if (!layers.has(part.digest) && layers.size >= 16) throw new ModelError("download");
        layers.set(part.digest, Math.min(part.total, part.completed));
        const completedBytes = Math.min(MODEL.downloadBytes, [...layers.values()].reduce((a, b) => a + b, 0));
        update({ completedBytes, progress: Math.min(0.99, completedBytes / MODEL.downloadBytes) }, true);
      }
    };
    try {
      checkAbort(signal);
      resetStall();
      const response = await deps.fetch(`${OLLAMA_URL}/api/pull`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL.tag, stream: true }), signal: controller.signal });
      if (!response.ok || !response.body) throw new ModelError("download");
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const part of response.body) {
        checkAbort(controller.signal);
        resetStall();
        buffer += decoder.decode(part, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          if (newline > 64 * 1024) throw new ModelError("download");
          accept(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 64 * 1024) throw new ModelError("download");
      }
      buffer += decoder.decode();
      accept(buffer);
      if (!success) throw new ModelError("download");
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(stall); clearTimeout(totalTimer); signal.removeEventListener("abort", abort); }
  }

  async function install() {
    await initialize();
    if (operation) return operation.promise;
    if (snapshot.state === "ready" && verified && child) return view();
    return run("install", async (signal) => {
      update({ hardware: await hardware(), error: null });
      if (!snapshot.hardware.supported) throw new ModelError("hardware");
      const cached = verified && await ownedManifestMatches();
      if (!cached && (snapshot.hardware.freeDiskBytes === null
        || snapshot.hardware.freeDiskBytes < snapshot.hardware.requiredFreeDiskBytes)) throw new ModelError("space");
      await save(); // retain this hardware-matched choice across interrupted downloads
      await startRuntime(signal);
      if (!cached) {
        update({ state: "downloading", completedBytes: 0, progress: 0 });
        await pull(signal);
      }
      await verifyModel(signal);
      checkAbort(signal);
      verified = true;
      await save();
      const currentHardware = await hardware();
      checkAbort(signal);
      update({ state: "ready", completedBytes: MODEL.downloadBytes, progress: 1, error: null,
        hardware: currentHardware });
    });
  }

  async function benchmark() {
    await initialize();
    if (operation) return operation.promise;
    if (!verified) return view();
    return run("benchmark", async (signal) => {
      await startRuntime(signal);
      await verifyModel(signal, false);
      update({ state: "benchmarking", error: null });
      const began = performance.now();
      const result = await jsonRequest("/api/generate", { model: MODEL.tag, stream: false,
        think: false, format: "json", prompt: "Extract facts from this fabricated contract. Return only JSON with reference (string), date (YYYY-MM-DD string), and amount (number). Text: Contract reference MIKE-42. Effective date: 15 January 2026. Fixed fee: USD 7,500.",
        options: { num_ctx: contextLength(), num_predict: 128, temperature: 0 } }, signal);
      if (!result.done || typeof result.response !== "string") throw new ModelError("benchmark");
      let parsed = {};
      try { parsed = JSON.parse(result.response); } catch { /* failed extraction is a measured result */ }
      const checks = [{ name: "Reference", passed: parsed?.reference === "MIKE-42" },
        { name: "Date", passed: parsed?.date === "2026-01-15" },
        { name: "Amount", passed: parsed?.amount === 7500 }];
      const rate = result.eval_count / (result.eval_duration / 1e9);
      const measured = { label: "Synthetic extraction smoke check", passed: checks.every((check) => check.passed),
        checks, totalChecks: 3, latencyMs: Math.round(performance.now() - began),
        tokensPerSecond: Number.isFinite(rate) && rate >= 0 && rate < 1000000 ? Math.round(rate * 10) / 10 : null,
        recordedAt: new Date().toISOString() };
      checkAbort(signal);
      update({ benchmark: measured });
      await save();
      checkAbort(signal);
      update({ state: "ready", error: null });
    });
  }

  async function cancel() {
    const current = operation;
    if (current) { current.controller.abort(); await stopRuntime(); await current.promise; }
    return view();
  }
  async function stop() {
    stopped = true;
    operation?.controller.abort();
    if (initialization) await initialization;
    await stopRuntime();
    if (operation) await operation.promise;
  }

  return { status: async () => { await initialize(); return view(); }, install, cancel, benchmark, stop };
}

module.exports = { createModelManager };
