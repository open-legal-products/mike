import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    cycles,
    dependencies,
    readPaths,
    resolveDependency,
    sourceFiles,
} from "./helpers/sourceDependencies";
const ROOT = resolve(__dirname, "../../..");
describe("source dependency contracts", () => {
    it("parses imports, re-exports, erased types, require and dynamic import without matching comments", () => {
        expect(dependencies(`
      // import 'fake';
      const text = "require('fake')";
      import type { T } from './types';
      import { type X } from './mixed';
      export { run } from './service';
      export type { Y } from './contract';
      type Z = import('./other').Z;
      const a = require('./legacy');
      const b = import('./lazy' as string);
    `)).toEqual([
            { specifier: "./types", typeOnly: true }, { specifier: "./mixed", typeOnly: true },
            { specifier: "./service", typeOnly: false }, { specifier: "./contract", typeOnly: true },
            { specifier: "./other", typeOnly: true }, { specifier: "./legacy", typeOnly: false },
            { specifier: "./lazy", typeOnly: false },
        ]);
        expect(() => dependencies("import(variable)")).toThrow("nonliteral");
    });
    it("detects indirect cycles and self imports, leaving acyclic dependencies alone", () => {
        expect(cycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['self', ['self']], ['root', ['leaf']], ['leaf', []]]))).toEqual([['a', 'b', 'c'], ['self']]);
    });
    it("resolves configured aliases and rejects missing local imports", () => {
        const file = join(ROOT, "backend/src/app.ts");
        expect(resolveDependency(file, "@/lib/serviceData", join(ROOT, "backend"), { "@/*": ["src/*"] })).toBe(join(ROOT, "backend/src/lib/serviceData.ts"));
        expect(() => resolveDependency(file, "./missing", ROOT, {})).toThrow("unresolved local");
    });
    it("has no cycles across backend, web, Word and desktop, including type-only dependencies", () => {
        const graph = new Map<string, string[]>();
        const domains = new Map<string, string[]>();
        for (const app of ["backend", "frontend", "word-addin", "desktop"]) {
            const root = join(ROOT, app);
            const config = join(root, "tsconfig.json");
            const paths = existsSync(config) ? readPaths(config) : {};
            for (const file of sourceFiles(join(root, "src"))) {
                const targets = dependencies(readFileSync(file, "utf8"), file).map(d => resolveDependency(file, d.specifier, root, paths)).filter((f): f is string => Boolean(f));
                graph.set(relative(ROOT, file), targets.map(f => relative(ROOT, f)));
                const domain = relative(ROOT, file).match(/^backend\/src\/modules\/([^/]+)\//)?.[1];
                if (domain && !file.endsWith(".routes.ts")) {
                    const otherDomains = targets.flatMap(t => {
                        const target = relative(ROOT, t).match(/^backend\/src\/modules\/([^/]+)\//)?.[1];
                        return target && target !== domain ? [target] : [];
                    });
                    domains.set(domain, [...(domains.get(domain) ?? []), ...otherDomains]);
                }
            }
        }
        // All syntax-level edges are checked: no erased cycle can be hidden by
        // changing an import to `import type`. This is stronger than a runtime check.
        expect(cycles(graph)).toEqual([]);
        expect(cycles(domains)).toEqual([]);
    });
});
