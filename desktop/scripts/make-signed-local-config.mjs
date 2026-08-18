// Generate electron-builder.release.local.json — the SIGNED build config for
// the self-contained app.
//
// Why generated: notarization requires every nested Mach-O in the bundle to
// carry its own hardened-runtime signature, and electron-builder only signs
// extra binaries it is explicitly told about (mac.binaries). The local stack
// carries dozens of them (postgres + its dylibs, gotrue, postgrest, any
// native .node modules the backend's production deps ship), and the exact
// set changes whenever a pinned version changes — so the list is scanned
// from local-stack/ at build time, never hand-maintained.
//
// Usage (after local:fetch + local:build + local:stage):
//   node scripts/make-signed-local-config.mjs
//   npm run dist:local:signed
//
// The paths emitted are prefixed with the packaged resources location
// (electron-builder resolves mac.binaries against the packaged app), and the
// dylib version-name SYMLINKS are excluded — codesign follows them to the
// real file, and signing a link twice fails the build.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const stack = path.join(desktop, "local-stack");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // codesign resolves links; skip
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function isMachO(file) {
  // Mach-O magic: FEEDFACF/CFFAEDFE (64-bit LE/BE) or CAFEBABE (universal).
  const fd = readFileSync(file, { length: 4 }).subarray(0, 4);
  if (fd.length < 4) return false;
  const magic = fd.readUInt32BE(0);
  return (
    magic === 0xfeedfacf ||
    magic === 0xcffaedfe ||
    magic === 0xcafebabe ||
    magic === 0xfeedface
  );
}

const machos = walk(stack)
  .filter((f) => {
    try {
      return lstatSync(f).size > 4 && isMachO(f);
    } catch {
      return false;
    }
  })
  .map((f) => path.relative(desktop, f).split(path.sep).join("/"));

if (machos.length === 0) {
  console.error("no Mach-O files found under local-stack/ — run local:fetch/local:stage first");
  process.exit(1);
}

const base = JSON.parse(
  readFileSync(path.join(desktop, "electron-builder.release.json"), "utf8"),
);
const config = {
  ...base,
  extraResources: [{ from: "local-stack", to: "local-stack", filter: ["**/*"] }],
  mac: {
    ...base.mac,
    // Inside the packaged app, extraResources land in Contents/Resources —
    // electron-builder signs mac.binaries entries at these packaged paths.
    binaries: machos.map((f) => `Contents/Resources/${f}`),
  },
};

const out = path.join(desktop, "electron-builder.release.local.json");
writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${path.basename(out)} with ${machos.length} nested Mach-O binaries to sign`);
