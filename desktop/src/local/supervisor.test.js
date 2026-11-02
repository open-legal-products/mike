const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hasExited,
  startLocalStack,
  stopLocalStack,
  localStackActive,
} = require("./supervisor");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  t.after(() => {
    process.resourcesPath = originalResources;
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
