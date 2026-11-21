// Refuse to start the backend on a Node older than package.json's engines
// floor, with a message that names the cause.
//
// undici 8 (the backend's HTTP client) needs Node 22.19+. On 22.14 the API
// crashed at boot inside undici/lib/interceptor/decompress.js, because
// zlib.createZstdDecompress does not exist there, and nothing in the stack
// said "your Node is too old" (MIKE-BACKEND-3R, MIK-129). npm's own engines
// check only warns, and `npm run dev` / `npm start` skip it entirely.
//
// Runs as the backend's `predev` and `prestart` script, before any backend
// module loads, and is also required by the desktop app's supervisor before
// it spawns the backend on Electron's Node. Plain CommonJS with no
// dependencies, so it works from a production install (no semver) and from
// the packaged app.
"use strict";

const fs = require("fs");
const path = require("path");

const FLOOR = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] for a ">=X.Y.Z" range; throws for anything else. */
function parseFloor(range) {
  const match = FLOOR.exec(String(range ?? "").trim());
  if (!match) {
    throw new Error(
      `check-node-version understands only ">=X.Y.Z" engines ranges, got ${JSON.stringify(range)}`,
    );
  }
  return match.slice(1).map(Number);
}

function parseVersion(version) {
  return String(version)
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** True when `version` (e.g. "22.14.0") is at or above the range's floor. */
function satisfiesFloor(version, range) {
  const floor = parseFloor(range);
  const have = parseVersion(version);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== floor[i]) return have[i] > floor[i];
  }
  return true;
}

/** The engines.node range of the backend package.json in `backendDir`. */
function backendNodeRange(backendDir = path.resolve(__dirname, "..")) {
  const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf8"));
  return pkg.engines && pkg.engines.node;
}

/** null when `version` can run the backend, else the message to show. */
function nodeVersionProblem(version, range) {
  if (satisfiesFloor(version, range)) return null;
  return (
    `Mike's backend needs Node ${range} (package.json "engines"), but this is Node ${version}. ` +
    "Older 22.x releases crash at boot inside undici. Install a newer Node 22 " +
    "(for example `nvm install 22`) and run the command again."
  );
}

module.exports = { parseFloor, satisfiesFloor, backendNodeRange, nodeVersionProblem };

if (require.main === module) {
  const problem = nodeVersionProblem(process.versions.node, backendNodeRange());
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
}
