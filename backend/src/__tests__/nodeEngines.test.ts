import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";

// The engines floor each package declares must be a Node version that every
// package its lockfile installs at run time supports. When it is not, an
// install on that "supported" version crashes with a stack inside a
// dependency and no hint that Node is the cause: undici 8 (engines
// >=22.19.0) under a declared ">=22" crashed the API at boot on Node 22.14,
// where zlib.createZstdDecompress does not exist (MIKE-BACKEND-3R, MIK-129).
//
// Two kinds of locked package are not held to this:
//   - devDependencies: they never run in a deployment. (Frontend test
//     tooling, jsdom and its CSS helpers, currently wants 22.22.2.)
//   - platform binaries (entries with `os` / `cpu`): npm skips them on every
//     other platform, and their engines are often stale copies of the parent
//     package's (sharp-win32-ia32 still says ^20.9.0).
const repoRoot = path.resolve(__dirname, "../../..");
const PACKAGES = [".", "backend", "frontend", "word-addin"];

type LockEntry = {
  dev?: boolean;
  os?: string[];
  cpu?: string[];
  engines?: { node?: string } | string[];
};

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8")) as T;

const declaredRange = (dir: string) =>
  readJson<{ engines?: { node?: string } }>(`${dir}/package.json`).engines?.node;

describe("Node engines floor", () => {
  it("is declared once, identically, by every package", () => {
    const ranges = Object.fromEntries(PACKAGES.map((dir) => [dir, declaredRange(dir)]));
    expect(new Set(Object.values(ranges)).size, JSON.stringify(ranges)).toBe(1);
  });

  it.each(PACKAGES)(
    "%s: the declared floor runs every runtime dependency in its lockfile",
    (dir) => {
      const range = declaredRange(dir);
      const floor = range ? semver.minVersion(range)?.version : undefined;
      expect(floor, `${dir}/package.json declares no engines.node`).toBeDefined();

      const lock = readJson<{ packages: Record<string, LockEntry> }>(
        `${dir}/package-lock.json`,
      );
      const tooOld = Object.entries(lock.packages).flatMap(([name, entry]) => {
        const needs = Array.isArray(entry.engines) ? undefined : entry.engines?.node;
        if (!name || !needs || entry.dev || entry.os || entry.cpu) return [];
        if (!semver.validRange(needs)) return [];
        return semver.satisfies(floor!, needs) ? [] : [`${name} needs node ${needs}`];
      });
      expect(tooOld, `floor ${floor} (${dir}/package.json "${range}")`).toEqual([]);
    },
  );
});
