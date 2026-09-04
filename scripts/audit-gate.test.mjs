// Regression tests for the FAIL-CLOSED contract of scripts/audit-gate.mjs.
//
// Run: node --test scripts/audit-gate.test.mjs
//
// The gate's only job is to refuse. Every bug it has had was the same bug —
// some path where "we could not check" printed the same "audit gate passed"
// as "we checked and it is clean" — so these tests assert the exit code for
// the two ways that has happened, not the advisory parsing.

import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = join(dirname(fileURLToPath(import.meta.url)), "audit-gate.mjs");

/** A registry that answers 200 with a JSON body that is not an advisory map. */
const requests = [];
const stub = createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "nope" }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
after(() => stub.close());

// spawn, never spawnSync: the stub registry runs on THIS process's event
// loop, and a synchronous child would block it — the child's requests would
// go unanswered until they timed out, turning a 0.2s test into a 100s one.
function runGate(lockfile) {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lockfile));
  const child = spawn(process.execPath, [gatePath], {
    cwd: dir,
    env: {
      ...process.env,
      npm_config_registry: stubUrl,
      OSV_API_BASE_URL: stubUrl,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const LOCKFILE_WITH_PACKAGES = {
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture", version: "1.0.0" },
    "node_modules/left-pad": { version: "1.3.0" },
  },
};

test("fails when the advisory services answer 200 with an error payload", async () => {
  // Both services are the stub, so npm fails validation and the OSV fallback
  // fails too. Passing here would mean shipping unaudited dependencies every
  // time a proxy or a captive network sat in front of the registry.
  const result = await runGate(LOCKFILE_WITH_PACKAGES);
  notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
  strictEqual(result.stdout.includes("audit gate passed"), false);
});

test("fails when the lockfile declares no packages, without calling out", async () => {
  // An npm 6 lockfile (or a truncated one) yields zero queries, so every loop
  // in the gate is skipped and it used to report a clean audit having made no
  // network call at all.
  requests.length = 0;
  const result = await runGate({ lockfileVersion: 1, dependencies: {} });
  notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
  strictEqual(result.stdout.includes("audit gate passed"), false);
  strictEqual(result.stderr.includes("no resolved packages"), true);
  // Nothing was consulted — which is exactly why it must not pass.
  deepStrictEqual(requests, []);
});
