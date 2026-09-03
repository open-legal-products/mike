// Architecture fitness test — the backend's layering rules, executable.
//
// Conventions are worthless if nothing checks them. This test walks every
// TypeScript file under `src/`, reads its import statements, and fails when a
// file crosses a boundary the module layout forbids. It needs no lint plugin
// or dependency-cruiser: a directory walk and a regex are enough to make the
// rules in `AGENTS.md` ("Backend Structure") load-bearing.
//
// The rules:
//
//   1. `lib/` is the shared kernel. It never imports from `modules/`.
//   2. A module is reached from outside only through its facade
//      (`modules/<domain>/<name>.service.ts`). Another module, a worker, a
//      job — none of them may import a module's topic files. The one other
//      entry point is `*.routes.ts`, and only `app.ts` may import it: that is
//      how a module's HTTP surface gets mounted.
//   3. Everything in a module except its `*.routes.ts` files is HTTP-agnostic:
//      no `express` import, no `req`/`res`.
//   4. Route files parse requests and map results; they never query the
//      database. Counted, not banned outright, so the debt that remains is
//      visible and can only shrink (a ratchet).
//   5. Facades re-export by name. `export *` hides what a module exposes.
//   6. `middleware/` is request plumbing; it depends on `lib/`, not on
//      domain modules.
//   7. `src/routes/` no longer exists. New HTTP surfaces are modules.
//
// Each rule has an explicit allowlist. Adding to an allowlist is a reviewable
// decision with a comment explaining why; silently widening one is not.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|mts|cts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const ALL_FILES = walk(SRC).map((f) => relative(SRC, f).split(sep).join("/"));
const isTestFile = (f: string) => /(^|\/)__tests__\//.test(f) || /\.test\.ts$/.test(f);
const PRODUCTION_FILES = ALL_FILES.filter((f) => !isTestFile(f));

function read(file: string): string {
  return readFileSync(join(SRC, file), "utf8");
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every import specifier in a file, resolved to an `src`-relative path when it is relative. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specs: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (spec.startsWith(".")) {
      const abs = resolve(SRC, dirname(file), spec);
      specs.push(relative(SRC, abs).split(sep).join("/"));
    } else {
      specs.push(spec);
    }
  }
  return specs;
}

const moduleOf = (file: string): string | null => {
  const m = /^modules\/([^/]+)\//.exec(file);
  return m ? m[1] : null;
};

/** The single facade file of a module, e.g. `modules/chat/chat.service`. */
function facadeOf(domain: string): string {
  const dir = join(SRC, "modules", domain);
  const facades = readdirSync(dir).filter((f) => /\.service\.ts$/.test(f));
  if (facades.length !== 1) {
    throw new Error(
      `modules/${domain} must have exactly one *.service.ts facade, found: ${facades.join(", ") || "none"}`,
    );
  }
  return `modules/${domain}/${facades[0].replace(/\.ts$/, "")}`;
}

const MODULES = existsSync(join(SRC, "modules"))
  ? readdirSync(join(SRC, "modules")).filter((d) =>
      statSync(join(SRC, "modules", d)).isDirectory(),
    )
  : [];

describe("backend architecture", () => {
  it("every module has exactly one facade and at least one routes file", () => {
    for (const domain of MODULES) {
      expect(() => facadeOf(domain)).not.toThrow();
      const files = readdirSync(join(SRC, "modules", domain));
      expect(
        files.some((f) => /\.routes\.ts$/.test(f)),
        `modules/${domain} has no *.routes.ts`,
      ).toBe(true);
    }
  });

  it("rule 1: lib/ never imports from modules/", () => {
    // Documented exceptions, each with the reason it has not been fixed yet.
    const ALLOWED = new Set<string>([
      // The stale-work sweeper re-runs tabular extraction jobs; it reaches the
      // tabular module through its facade only. Moving the sweeper into the
      // module would make lib/maintenance depend on a queue it should not
      // know about. Tracked as a follow-up in docs/backend-architecture.md.
      "lib/maintenance/staleWork.ts",
    ]);
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES.filter((f) => f.startsWith("lib/"))) {
      if (ALLOWED.has(file)) continue;
      for (const spec of importsOf(file)) {
        if (spec.startsWith("modules/")) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rule 2: a module is imported from outside only through its facade", () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES) {
      const own = moduleOf(file);
      for (const spec of importsOf(file)) {
        const target = moduleOf(spec + "/");
        if (!target || target === own) continue;
        if (spec === facadeOf(target)) continue;
        // app.ts mounts routers; a routes file is a module's HTTP entry point.
        if (file === "app.ts" && /\.routes$/.test(spec)) continue;
        offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rule 3: only *.routes.ts inside a module may import express", () => {
    const ALLOWED = new Set<string>([
      // The tabular generate stream writes SSE frames while it runs
      // extraction; the streaming loop is the documented layering exception
      // (see the file header). It takes `res` explicitly rather than hiding
      // it in a closure so the exception stays visible at the call site.
      "modules/tabular/tabular.generateStream.ts",
    ]);
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES) {
      if (!file.startsWith("modules/")) continue;
      if (/\.routes\.ts$/.test(file) || ALLOWED.has(file)) continue;
      const specs = importsOf(file);
      if (specs.includes("express")) offenders.push(file);
      const text = read(file);
      if (/\bres\.(status|json|setHeader|send|write)\(/.test(text))
        offenders.push(`${file} (writes to res)`);
    }
    expect(offenders).toEqual([]);
  });

  it("rule 4: route files do not query the database (ratchet)", () => {
    // Remaining inline queries per routes file. A number may go DOWN when a
    // handler is moved behind its service; it must never go up. Delete the
    // entry when the file reaches zero.
    const BASELINE: Record<string, number> = {};
    const counts: Record<string, number> = {};
    for (const file of PRODUCTION_FILES) {
      if (!/\.routes\.ts$/.test(file)) continue;
      const text = read(file);
      const n = (text.match(/\.(from|rpc)\(\s*["']/g) ?? []).length;
      if (n > 0) counts[file] = n;
    }
    const regressions = Object.entries(counts)
      .filter(([file, n]) => n > (BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > baseline ${BASELINE[file] ?? 0}`);
    expect(regressions).toEqual([]);
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (counts[file] ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n} is stale, now ${counts[file] ?? 0}`);
    expect(stale, "lower the baseline so the ratchet keeps its teeth").toEqual([]);
  });

  it("rule 5: facades re-export by name, never `export *`", () => {
    const offenders = MODULES.map((d) => `${facadeOf(d)}.ts`).filter((f) =>
      /^\s*export\s+\*\s+from/m.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("rule 6: middleware/ never imports from modules/", () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES.filter((f) => f.startsWith("middleware/"))) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith("modules/")) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rule 7: src/routes/ is gone; HTTP surfaces are modules", () => {
    expect(existsSync(join(SRC, "routes"))).toBe(false);
  });
});
