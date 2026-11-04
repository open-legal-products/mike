import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    cycles,
    dependencies,
    dependencyGraph,
    loadSourceParser,
    resolveDependency,
} from "./helpers/sourceDependencies";
const ROOT = resolve(__dirname, "../../..");
const APPS = ["backend", "frontend", "word-addin", "desktop"];
beforeAll(loadSourceParser);
/** A throwaway repository: `files` maps repo-relative paths to contents. */
function repository(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "mike-dependency-graph-"));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
}
const APP_CONFIG = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"], "@mike/shared": ["../packages/shared/src/index.ts"], "@mike/contracts": ["../packages/contracts/index.d.ts"] } } });
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
    it("parses TypeScript generics separately from JSX", () => {
        expect(dependencies("const identity = <T>(value: T): T => value;", "source.ts")).toEqual([]);
        expect(dependencies("import { Widget } from './widget'; const view = <Widget />;", "source.tsx")).toEqual([
            { specifier: "./widget", typeOnly: false },
        ]);
    });
    it("parses declaration files, counting reference-path directives as erased dependencies", () => {
        expect(dependencies(`
      /// <reference path="./globals.d.ts" />
      /// <reference types="node" />
      // <reference path="./commented-out.d.ts" />
      import type { Shape } from "./shape";
      declare module "*.svg" { const asset: import("./asset").Asset; export default asset; }
      declare const VERSION: string;
    `, "ambient.d.ts")).toEqual([
            { specifier: "./shape", typeOnly: true },
            { specifier: "./asset", typeOnly: true },
            { specifier: "./globals.d.ts", typeOnly: true },
        ]);
    });
    it("detects indirect cycles and self imports, leaving acyclic dependencies alone", () => {
        expect(cycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['self', ['self']], ['root', ['leaf']], ['leaf', []]]))).toEqual([['a', 'b', 'c'], ['self']]);
    });
    it("resolves configured aliases and rejects missing local imports", () => {
        const file = join(ROOT, "backend/src/app.ts");
        expect(resolveDependency(file, "@/lib/serviceData", join(ROOT, "backend"), { "@/*": ["src/*"] })).toBe(join(ROOT, "backend/src/lib/serviceData.ts"));
        expect(() => resolveDependency(file, "./missing", ROOT, {})).toThrow("unresolved local");
    });
    describe("graph over applications and shared packages", () => {
        const roots: string[] = [];
        afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
        function graphOf(files: Record<string, string>) {
            const root = repository({ "app/tsconfig.json": APP_CONFIG, ...files });
            roots.push(root);
            return dependencyGraph(root, ["app"]);
        }
        it("traverses a shared package reached through an alias and finds a cycle inside it", () => {
            // The package files are never enumerated as an application's src/;
            // only the traversal from app/src/entry.ts reaches them.
            const graph = graphOf({
                "app/src/entry.ts": `import { run } from "@mike/shared"; run();`,
                "packages/shared/src/index.ts": `export { run } from "./run";`,
                "packages/shared/src/run.ts": `import type { Options } from "./options"; export function run(o?: Options) { return o; }`,
                "packages/shared/src/options.ts": `import type { run } from "./run"; export type Options = Parameters<typeof run>;`,
            });
            expect([...graph.keys()]).toEqual(["app/src/entry.ts", "packages/shared/src/index.ts", "packages/shared/src/options.ts", "packages/shared/src/run.ts"]);
            expect(cycles(graph)).toEqual([["packages/shared/src/options.ts", "packages/shared/src/run.ts"]]);
        });
        it("finds a cycle that crosses the application/package boundary", () => {
            const graph = graphOf({
                "app/src/entry.ts": `export const feature = "x"; import "@mike/shared";`,
                "packages/shared/src/index.ts": `import type { feature } from "../../../app/src/entry"; export type Feature = typeof feature;`,
            });
            expect(cycles(graph)).toEqual([["app/src/entry.ts", "packages/shared/src/index.ts"]]);
        });
        it("treats a declaration-only package like any other source, including type-only cycles", () => {
            const graph = graphOf({
                "app/src/types.ts": `import type { Event } from "@mike/contracts"; export type Wire = Event;`,
                "packages/contracts/index.d.ts": `import type { Wire } from "../../app/src/types"; export type Event = { wire: Wire };`,
            });
            expect(cycles(graph)).toEqual([["app/src/types.ts", "packages/contracts/index.d.ts"]]);
        });
        it("checks local declaration files and their reference-path directives", () => {
            const graph = graphOf({
                "app/src/main.ts": `export const main = 1;`,
                "app/src/env.d.ts": `/// <reference path="./globals.d.ts" />\ndeclare const ENV: string;`,
                "app/src/globals.d.ts": `import type { ENV } from "./env";\ndeclare const GLOBAL: typeof ENV;`,
            });
            expect(cycles(graph)).toEqual([["app/src/env.d.ts", "app/src/globals.d.ts"]]);
        });
        it("enumerates a package no application imports yet", () => {
            const graph = graphOf({
                "app/src/main.ts": `export const main = 1;`,
                "packages/orphan/src/index.ts": `import "./index";`,
            });
            expect(cycles(graph)).toEqual([["packages/orphan/src/index.ts"]]);
        });
        it("leaves acyclic shared code alone and skips tests, stories and node_modules", () => {
            const graph = graphOf({
                "app/src/entry.ts": `import { run } from "@mike/shared"; import "@/util"; run();`,
                "app/src/util.ts": `export {};`,
                "app/src/util.test.ts": `import "./entry";`,
                "packages/shared/src/index.ts": `export { run } from "./run";`,
                "packages/shared/src/run.ts": `export function run() {}`,
                "packages/shared/src/run.stories.tsx": `import { run } from "./run"; run();`,
                "packages/shared/node_modules/dep/index.ts": `import "../../src/index";`,
            });
            expect([...graph.keys()]).toEqual(["app/src/entry.ts", "app/src/util.ts", "packages/shared/src/index.ts", "packages/shared/src/run.ts"]);
            expect(cycles(graph)).toEqual([]);
        });
    });
    it("has no cycles across backend, web, Word, desktop and the shared packages, including type-only dependencies", () => {
        const graph = dependencyGraph(ROOT, APPS);
        // The shared packages are in the graph, not only edges into nothing.
        expect(graph.has("packages/contracts/index.d.ts")).toBe(true);
        const domains = new Map<string, string[]>();
        const domainOf = (file: string) => file.match(/^backend\/src\/modules\/([^/]+)\//)?.[1];
        for (const [file, targets] of graph) {
            const domain = domainOf(file);
            if (!domain || file.endsWith(".routes.ts"))
                continue;
            const otherDomains = targets.flatMap(t => {
                const target = domainOf(t);
                return target && target !== domain ? [target] : [];
            });
            domains.set(domain, [...(domains.get(domain) ?? []), ...otherDomains]);
        }
        // All syntax-level edges are checked: no erased cycle can be hidden by
        // changing an import to `import type`. This is stronger than a runtime check.
        expect(cycles(graph)).toEqual([]);
        expect(cycles(domains)).toEqual([]);
    });
});
