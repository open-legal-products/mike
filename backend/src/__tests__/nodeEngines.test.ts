import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
// The script the backend's predev/prestart run (plain CommonJS, no deps).
import { nodeVersionProblem, parseFloor } from "../../scripts/check-node-version.cjs";

// The engines floor each package declares must be a Node version that every
// package its lockfile installs at run time supports. When it is not, an
// install on that "supported" version crashes with a stack inside a
// dependency and no hint that Node is the cause: undici 8 (engines
// >=22.19.0) under a declared ">=22" crashed the API at boot on Node 22.14,
// where zlib.createZstdDecompress does not exist (MIKE-BACKEND-3R, MIK-129).
//
// Dev dependencies are held to it too: the 3R events came from `npm run dev`
// (tsx), and next/typescript/tailwind run inside the frontend image's
// `next build`. Two exceptions:
//   - DEV_ONLY_ABOVE_FLOOR: frontend unit-test tooling (jsdom and its CSS and
//     DOM helpers) that wants 22.22.2. It runs only under Vitest, never in a
//     deployment or a build, so it may need more than the floor. Anything
//     added here must be test-only, by name.
//   - platform binaries (entries with `os` / `cpu`): npm skips them on every
//     other platform, and their engines are often stale copies of the parent
//     package's (sharp-win32-ia32 still says ^20.9.0).
const repoRoot = path.resolve(__dirname, "../../..");
// desktop/ runs the backend on Electron's bundled Node (its supervisor checks
// that Node against backend/package.json before spawning it).
const PACKAGES = [".", "backend", "frontend", "word-addin", "desktop"];
const DEV_ONLY_ABOVE_FLOOR = new Set([
  "jsdom",
  "w3c-xmlserializer",
  "@asamuzakjp/css-color",
  "@asamuzakjp/dom-selector",
]);

/** "node_modules/a/node_modules/@s/b" -> "@s/b" */
const packageName = (lockPath: string) => lockPath.split("node_modules/").pop() ?? lockPath;

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
    "%s: the declared floor runs every dependency in its lockfile",
    (dir) => {
      const range = declaredRange(dir);
      const floor = range ? semver.minVersion(range)?.version : undefined;
      expect(floor, `${dir}/package.json declares no engines.node`).toBeDefined();

      const lock = readJson<{ packages: Record<string, LockEntry> }>(
        `${dir}/package-lock.json`,
      );
      const tooOld = Object.entries(lock.packages).flatMap(([name, entry]) => {
        const needs = Array.isArray(entry.engines) ? undefined : entry.engines?.node;
        if (!name || !needs || entry.os || entry.cpu) return [];
        if (entry.dev && DEV_ONLY_ABOVE_FLOOR.has(packageName(name))) return [];
        if (!semver.validRange(needs)) return [];
        return semver.satisfies(floor!, needs) ? [] : [`${name} needs node ${needs}`];
      });
      expect(tooOld, `floor ${floor} (${dir}/package.json "${range}")`).toEqual([]);
    },
  );
});

// Declaring the floor only makes npm warn, and `npm run dev` / `npm start`
// never check it, so on 22.14 the API still crashed inside undici with no
// hint (the MIKE-BACKEND-3R events came from `tsx watch`). Installs and
// starts must refuse an unsupported Node with a message naming the cause.
describe("backend refuses an unsupported Node", () => {
  const backend = readJson<{ scripts: Record<string, string>; engines: { node: string } }>(
    "backend/package.json",
  );

  it("fails npm install/ci instead of warning (engine-strict)", () => {
    const npmrc = readFileSync(path.join(repoRoot, "backend/.npmrc"), "utf8");
    expect(npmrc).toMatch(/^engine-strict=true$/m);
  });

  it("checks the running Node before dev and start", () => {
    expect(backend.scripts.predev).toBe("node scripts/check-node-version.cjs");
    expect(backend.scripts.prestart).toBe("node scripts/check-node-version.cjs");
  });

  it("reads the declared floor the same way semver does", () => {
    expect(parseFloor(backend.engines.node).join(".")).toBe(
      semver.minVersion(backend.engines.node)?.version,
    );
  });

  it.each([
    ["22.14.0", false],
    ["22.18.9", false],
    ["22.19.0", true],
    ["22.22.2", true],
    ["24.0.0", true],
  ])("Node %s can run it: %s", (version, ok) => {
    const problem = nodeVersionProblem(version, backend.engines.node);
    if (ok) expect(problem).toBeNull();
    else {
      expect(problem).toContain("needs Node >=22.19.0");
      expect(problem).toContain(`this is Node ${version}.`);
    }
  });

  // What `npm run dev` / `npm start` actually run, on a Node that reports
  // the given version (process.versions is replaced before the script loads).
  const runCheck = (version: string) =>
    spawnSync(
      process.execPath,
      [
        `--import=data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"${version}"}})`,
        path.join(repoRoot, "backend/scripts/check-node-version.cjs"),
      ],
      { encoding: "utf8" },
    );

  it("the predev/prestart script exits 1 on Node 22.14 and names the cause", () => {
    const result = runCheck("22.14.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs Node >=22.19.0");
    expect(result.stderr).toContain("this is Node 22.14.0.");
  });

  it("the predev/prestart script exits 0 on the floor", () => {
    const result = runCheck("22.19.0");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
