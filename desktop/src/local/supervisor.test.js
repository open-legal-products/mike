const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertBackendNodeSupported,
  hasExited,
  startLocalStack,
  stopLocalStack,
  localStackActive,
} = require("./supervisor");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match the packaged layout with the real checker and a controlled requirement.
function stageBackendCheck(resources, range = ">=22.19.0") {
  const backend = path.join(resources, "local-stack", "app", "backend");
  fs.mkdirSync(path.join(backend, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, "../../../backend/scripts/check-node-version.cjs"),
    path.join(backend, "scripts", "check-node-version.cjs"),
  );
  fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ engines: { node: range } }));
}

// The stop loop and the boot-time crash detector both ask "is this child
// gone?". A process killed by a signal never gets an exit CODE — Node reports
// exitCode === null and signalCode === "SIGTERM" — which is exactly how
// PostgREST leaves on every quit. Reading exitCode alone therefore answered
// "still running" for a dead process, and Cmd+Q sat through the whole 10 s
// deadline.
test("hasExited is true for a child killed by a signal, not only for a clean exit code", async () => {
  const killed = spawn("sleep", ["30"]);
  const clean = spawn("sh", ["-c", "exit 3"]);
  assert.equal(hasExited(killed), false, "a running child has not exited");
  killed.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while ((!hasExited(killed) || !hasExited(clean)) && Date.now() < deadline) await sleep(20);
  assert.equal(killed.exitCode, null, "signal death carries no exit code (the trap)");
  assert.equal(killed.signalCode, "SIGTERM");
  assert.equal(hasExited(killed), true);
  assert.equal(clean.exitCode, 3);
  assert.equal(hasExited(clean), true);
});

// Cmd+Q during the first-run boot used to find localStackRunning() false and
// skip the stop, orphaning postgres/gotrue on the fixed ports. The quit path
// must see a booting stack as active, and a stop must end the boot without
// it spawning anything more.
test("a stop during boot ends the boot and leaves nothing running", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mike-supervisor-"));
  const pgBin = path.join(tmp, "resources", "local-stack", "bin", "pg", "bin");
  fs.mkdirSync(pgBin, { recursive: true });
  // A "postgres" that never becomes reachable, so the boot stays in waitFor.
  fs.writeFileSync(path.join(pgBin, "postgres"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(path.join(userData, "local", "pgdata"), { recursive: true });
  fs.writeFileSync(path.join(userData, "local", "pgdata", "PG_VERSION"), "16\n");

  const originalResources = process.resourcesPath;
  process.resourcesPath = path.join(tmp, "resources");
  stageBackendCheck(process.resourcesPath);
  t.after(() => {
    process.resourcesPath = originalResources;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const app = { isPackaged: true, getPath: () => userData };

  const statuses = [];
  const booting = startLocalStack(app, (msg) => statuses.push(msg));
  const deadline = Date.now() + 5_000;
  while (!statuses.includes("Starting database…") && Date.now() < deadline) await sleep(20);
  assert.equal(localStackActive(), true, "a booting stack must count as active");

  await stopLocalStack();
  await assert.rejects(booting, /stopped during boot/);
  assert.equal(localStackActive(), false);
  assert.ok(!statuses.includes("Starting auth…"), "no service starts after the stop");
});

// The backend runs on Electron's bundled Node. A Node below the backend's
// engines floor crashed it at boot inside undici (MIKE-BACKEND-3R), so the
// supervisor refuses to start the stack on one, naming the cause.
test("refuses to start the backend on an Electron whose Node is below the backend's engines floor", () => {
  const backendDir = path.resolve(__dirname, "../../../backend");
  const fakeNode = (version) => ({
    NODE_OPTIONS: `--import="data:text/javascript,Object.defineProperty(process,'versions',{value:{...process.versions,node:'${version}'}})"`,
  });
  assert.throws(
    () => assertBackendNodeSupported(backendDir, fakeNode("22.14.0")),
    (error) => {
      assert.match(error.message, /Electron's Node\. Mike's backend needs Node >=22\.19\.0 .* this is Node 22\.14\.0/);
      assert.match(error.message, /Install an updated Mike app/);
      assert.ok(!error.message.includes("nvm install"));
      return true;
    },
  );
  assert.doesNotThrow(() => assertBackendNodeSupported(backendDir, fakeNode("22.22.0")));
  // The Node this test runs on (the same floor applies to it).
  assert.doesNotThrow(() => assertBackendNodeSupported(backendDir));
});

for (const returning of [false, true]) {
  test(`incompatible packaged runtime leaves ${returning ? "existing" : "new"} workspace untouched`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mike-runtime-preflight-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const resources = path.join(tmp, "resources");
    // This simulates a backend requiring a newer Node than the bundled one.
    stageBackendCheck(resources, ">=999.0.0");
    const userData = path.join(tmp, "userData");
    if (returning) {
      fs.mkdirSync(path.join(userData, "local", "pgdata"), { recursive: true });
      fs.writeFileSync(path.join(userData, "local", "pgdata", "PG_VERSION"), "16\n");
      fs.writeFileSync(path.join(userData, "local", "secrets.json"), "existing secrets\n");
    }
    const originalResources = process.resourcesPath;
    process.resourcesPath = resources;
    t.after(() => { process.resourcesPath = originalResources; });
    const statuses = [];
    await assert.rejects(
      startLocalStack({ isPackaged: true, getPath: () => userData }, (msg) => statuses.push(msg)),
      /Install an updated Mike app/,
    );
    assert.deepEqual(statuses, [], "no service or migration stage starts");
    assert.equal(localStackActive(), false);
    if (returning) {
      assert.deepEqual(fs.readdirSync(path.join(userData, "local")).sort(), ["pgdata", "secrets.json"]);
      assert.deepEqual(fs.readdirSync(path.join(userData, "local", "pgdata")), ["PG_VERSION"]);
      assert.equal(fs.readFileSync(path.join(userData, "local", "pgdata", "PG_VERSION"), "utf8"), "16\n");
      assert.equal(fs.readFileSync(path.join(userData, "local", "secrets.json"), "utf8"), "existing secrets\n");
    } else {
      assert.equal(fs.existsSync(userData), false, "no workspace directories or secrets are created");
    }
  });
}
