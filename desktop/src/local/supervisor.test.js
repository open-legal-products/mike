const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { hasExited } = require("./supervisor");

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
