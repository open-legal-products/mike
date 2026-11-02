// Architecture fitness test — the frontend's build-boundary rules, executable.
//
// The production image is built from a Docker context that holds the frontend
// plus an explicit allowlist of sibling directories (see `frontend/Dockerfile`).
// A file that `next build` type-checks and that reaches outside that allowlist
// compiles on a developer machine and in the host-side CI build, where every
// sibling directory exists, and fails only inside `docker compose up --build`
// on a fresh install. That happened three times (24dc0f97 for backend/src,
// #457 for word-addin/src, #501 for packages/pdf-text-order) before this test
// existed, because nothing tied the Dockerfile's allowlist to the import graph.
//
// The rules:
//
//   1. Every file in the production build program (`tsconfig.build.json`, the
//      config `next build` uses) stays inside `frontend/`: no relative import
//      may resolve to a path outside it.
//   2. Production code reaches outside `frontend/` only through a `paths`
//      alias, and every alias target outside `frontend/` must be copied by
//      the Dockerfile to exactly the path the alias resolves to in the image.
//   3. The build program excludes test-only files and nothing else. Every
//      other file tsconfig.json sees must still be in the build, so an
//      exclude pattern cannot quietly drop production code from type-checking.
//
// Test files may import shared fixtures and add-in sources from outside
// `frontend/`; rule 3 is what keeps them out of the image. The faithful check
// is `.github/workflows/docker-images.yml`, which builds the real image; this
// test is the fast one that names the offending import.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FRONTEND = resolve(__dirname, "../..");
const REPO = resolve(FRONTEND, "..");

const toPosix = (p: string) => p.split(sep).join("/");
const relToFrontend = (file: string) => toPosix(relative(FRONTEND, file));

function isInside(dir: string, file: string): boolean {
    const rel = relative(dir, file);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadProgram(configName: string): ts.ParsedCommandLine {
    const configPath = join(FRONTEND, configName);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(read.error, `${configName} must parse`).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, FRONTEND);
    expect(parsed.fileNames.length, `${configName} must include files`).toBeGreaterThan(0);
    return parsed;
}

const IMPORT_RE =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
        out.push(match[1] ?? match[2]);
    }
    return out;
}

const isTestOnly = (rel: string) =>
    /\.(test|spec)\.tsx?$/.test(rel) ||
    /(^|\/)__tests__\//.test(rel) ||
    rel === "vitest.config.mts" ||
    rel === "vitest.setup.ts";

// The Dockerfile, reduced to what matters here: where the frontend lands in
// the image and which repository paths are copied where.
function readDockerfile() {
    const lines = readFileSync(join(FRONTEND, "Dockerfile"), "utf8").split("\n");
    let workdir = "/";
    const copies: { src: string; dst: string }[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        const wd = /^WORKDIR\s+(\S+)/.exec(line);
        if (wd) {
            workdir = posix.resolve(workdir, wd[1]);
            continue;
        }
        const cp = /^COPY\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/.exec(line);
        if (cp) {
            copies.push({
                src: posix.normalize(cp[1]).replace(/\/$/, ""),
                dst: posix.resolve(workdir, cp[2]),
            });
        }
    }
    const app = copies.find((c) => c.src === "frontend");
    expect(app, "Dockerfile must COPY frontend/ into the image").toBeDefined();
    return { app: app!.dst, copies: copies.filter((c) => !c.src.includes("*")) };
}

describe("frontend build boundaries", () => {
    const build = loadProgram("tsconfig.build.json");
    const full = loadProgram("tsconfig.json");

    it("rule 1: nothing in the production build program imports from outside frontend/", () => {
        const violations: string[] = [];
        for (const file of build.fileNames) {
            for (const spec of importSpecifiers(file)) {
                if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
                const target = resolve(dirname(file), spec);
                if (!isInside(FRONTEND, target)) {
                    violations.push(`${relToFrontend(file)} -> ${spec}`);
                }
            }
        }
        expect(
            violations,
            "A file `next build` type-checks reaches outside frontend/. The Docker " +
                "image is built from an allowlisted context and will not contain the " +
                "target. Import it through a tsconfig `paths` alias whose target the " +
                "Dockerfile copies, or, if it is a test, name it so " +
                "tsconfig.build.json excludes it.",
        ).toEqual([]);
    });

    it("rule 2: every tsconfig alias that leaves frontend/ is copied to the same path in the image", () => {
        const { app, copies } = readDockerfile();
        const paths = build.options.paths ?? {};
        const base = build.options.baseUrl ?? FRONTEND;
        const missing: string[] = [];
        for (const [alias, targets] of Object.entries(paths)) {
            for (const target of targets) {
                const abs = resolve(base, target);
                if (isInside(FRONTEND, abs)) continue;
                const repoRel = toPosix(relative(REPO, abs));
                const imagePath = posix.join(app, toPosix(relative(FRONTEND, abs)));
                const covered = copies.some(
                    (c) =>
                        (repoRel === c.src || repoRel.startsWith(`${c.src}/`)) &&
                        posix.join(c.dst, repoRel.slice(c.src.length)) === imagePath,
                );
                if (!covered) missing.push(`${alias} -> ${target} (expected ${imagePath} in the image)`);
            }
        }
        expect(
            missing,
            "A tsconfig `paths` alias points outside frontend/ but frontend/Dockerfile " +
                "does not COPY its target to the path the alias resolves to under the " +
                "image's WORKDIR.",
        ).toEqual([]);
    });

    it("rule 3: the build program excludes test-only files and nothing else", () => {
        const inBuild = new Set(build.fileNames);
        const dropped = full.fileNames
            .filter((f) => !inBuild.has(f))
            .map(relToFrontend)
            .filter((rel) => !isTestOnly(rel));
        expect(
            dropped,
            "tsconfig.build.json excludes a file that is not test-only, so `next build` " +
                "no longer type-checks it.",
        ).toEqual([]);

        const testsInBuild = build.fileNames.map(relToFrontend).filter(isTestOnly);
        expect(testsInBuild, "tsconfig.build.json must exclude every test-only file").toEqual([]);
    });
});
