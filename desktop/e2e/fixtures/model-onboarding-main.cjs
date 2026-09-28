// Test-only entry point. Install process-local fakes BEFORE requiring the real
// application. Production code has no environment toggle for bypassing models.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const electron = require("electron");
const desktop = path.resolve(__dirname, "../..");
const mainFile = path.join(desktop, "src/main.js");
const root = process.env.MIKE_USER_DATA_DIR;
if (!root || !root.includes("mike-model-onboarding-")) throw new Error("Fixture requires isolated userData");

const counts = { created: 0, install: 0, cancel: 0, benchmark: 0, export: 0, stackStarts: 0, stackStops: 0, restores: 0, stop: 0 };
let listener = () => {};
let pendingInstall = null;
let pendingRestore = null;
let restoring = null;
let running = false;
let state = {
  state: "not-installed", modelId: "ollama/qwen3.5:2b", modelName: "Qwen 3.5 2B",
  downloadBytes: 2741192820, completedBytes: 0, progress: 0, error: null, benchmark: null,
  hardware: { platform: "darwin", arch: "arm64", memoryBytes: 8 * 1024 ** 3,
    freeDiskBytes: 30 * 1024 ** 3, supported: true, recommendation: "Small starter selected for this test Mac." },
  // Deliberately present in the fake to prove the export allowlist is narrow.
  privateDebug: "NEVER-EXPORT-THIS-FIXTURE-SECRET",
};
const view = () => structuredClone(state);
function update(patch) { state = { ...state, ...patch }; listener(view()); return view(); }
const manager = {
  status: async () => {
    if (process.env.MIKE_MODEL_FIXTURE_PENDING_RESTORE === "1") {
      if (!restoring) {
        counts.restores++;
        update({ state: "starting" });
        restoring = new Promise((resolve) => { pendingRestore = resolve; });
      }
      return restoring;
    }
    return view();
  },
  install: async () => {
    counts.install++;
    if (counts.install === 2) return update({ state: "error", error: "Fixture connection interrupted. Retry the download." });
    update({ state: "downloading", error: null, progress: 0.35, completedBytes: 959417487 });
    return new Promise((resolve) => { pendingInstall = resolve; });
  },
  cancel: async () => {
    counts.cancel++;
    const result = update({ state: "cancelled", error: null });
    pendingInstall?.(result); pendingInstall = null;
    return result;
  },
  benchmark: async () => {
    counts.benchmark++;
    update({ state: "benchmarking" });
    return update({ state: "ready", benchmark: {
      label: "Synthetic extraction smoke check", passed: true,
      checks: [{ name: "Reference", passed: true }, { name: "Date", passed: true }, { name: "Amount", passed: true }],
      totalChecks: 3, latencyMs: 1250, tokensPerSecond: 18.4, recordedAt: "2026-09-23T12:00:00.000Z",
    } });
  },
  stop: async () => {
    counts.stop++;
    const result = update({ state: "cancelled" });
    pendingInstall?.(result); pendingInstall = null;
    pendingRestore?.(result); pendingRestore = null;
  },
};
function stub(relative, exports) {
  const filename = path.join(desktop, relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub("src/local/model-manager.js", { createModelManager: (_app, options) => {
  counts.created++; listener = options.onStatus; return manager;
} });
stub("src/local/supervisor.js", {
  localStackRunning: () => running,
  startLocalStack: async (_app, status) => { counts.stackStarts++; running = true; status("Fixture workspace ready"); },
  stopLocalStack: async () => { counts.stackStops++; running = false; },
});

function fixtureServer(name) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1>${req.url === "/frame" ? "" : '<iframe title="Untrusted child" src="/frame"></iframe>'}</body></html>`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

void (async () => {
  const local = await fixtureServer("Fixture local workspace");
  const remote = await fixtureServer("Fixture remote app");
  const originalConfig = require(path.join(desktop, "src/local/config.js"));
  stub("src/local/config.js", {
    ...originalConfig, FRONTEND_URL: local.url,
    // Availability needs a file, not an executable; no stack is ever spawned.
    stackPaths: () => ({ gotrue: process.env.MIKE_MODEL_FIXTURE_NO_STACK === "1"
      ? path.join(root, "absent-stack-binary") : __filename }),
  });
  // A shell-only launch uses our loopback remote fixture, never the live site.
  if (process.env.MIKE_MODEL_FIXTURE_NO_STACK === "1") process.env.MIKE_SERVER_URL = remote.url;
  const exportPath = path.join(root, "deployment-brief.md");
  electron.dialog.showSaveDialog = async () => {
    counts.export++; return { canceled: false, filePath: exportPath };
  };
  globalThis.__modelHarness = {
    counts: () => ({ ...counts }), localUrl: local.url, remoteUrl: remote.url, exportPath,
    modelPage: path.join(desktop, "src/pages/local-model.html"),
    completeInstall: () => {
      const result = update({ state: "ready", error: null, progress: 1, completedBytes: state.downloadBytes });
      pendingInstall?.(result); pendingInstall = null;
    },
    failedMeasurement: () => update({ benchmark: { ...state.benchmark, passed: false,
      checks: [{ name: "Reference", passed: true }, { name: "Date", passed: false }, { name: "Amount", passed: false }] } }),
    unsupported: () => update({ state: "not-installed", benchmark: null, error: null, progress: 0,
      hardware: { ...state.hardware, supported: false, arch: "x64", recommendation: "Local AI is unavailable on this test Mac. Continue without a model." } }),
    readExport: () => fs.readFileSync(exportPath, "utf8"),
  };
  electron.app.on("will-quit", () => {
    fs.writeFileSync(path.join(root, "lifecycle-counts.json"), JSON.stringify(counts));
    local.server.close(); remote.server.close();
  });

  // Deliberately make the real preload available to hostile child frames in
  // this harness. Production leaves nodeIntegrationInSubFrames off; the test
  // gives the attacker MORE access and still requires main-side IPC denial.
  function TestBrowserWindow(options) {
    return new electron.BrowserWindow({ ...options, webPreferences: {
      ...options.webPreferences, nodeIntegrationInSubFrames: true,
    } });
  }
  Object.setPrototypeOf(TestBrowserWindow, electron.BrowserWindow);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron" && parent?.filename === mainFile) {
      return { ...electron, BrowserWindow: TestBrowserWindow };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { require(mainFile); } finally { Module._load = originalLoad; }
})().catch((error) => { console.error(error); electron.app.exit(1); });
