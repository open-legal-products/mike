// Babel 8 is ESM-only; these test helpers are checked as CommonJS.
let parse: typeof import("@babel/parser", { with: { "resolution-mode": "import" } }).parse;
export async function loadSourceParser(): Promise<void> {
    ({ parse } = await import("@babel/parser"));
}
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
export type Dependency = {
    specifier: string;
    typeOnly: boolean;
};
type Ast = {
    type: string;
    [key: string]: unknown;
};
const isDeclaration = (file: string) => /\.d\.[cm]?ts$/.test(file);
/**
 * Parse syntax, not comments/string contents. Include erased dependencies too.
 * A declaration file is parsed as one, and its `/// <reference path="…" />`
 * directives count as (erased) dependencies: they are the only way a `.d.ts`
 * can name another local file without an import.
 */
export function dependencies(source: string, filename = "source.ts"): Dependency[] {
    type Plugin = Parameters<typeof parse>[1] extends { plugins?: Array<infer P> } | undefined ? P : never;
    const typescript: Plugin = isDeclaration(filename) ? ["typescript", { dts: true }] : "typescript";
    const ast = parse(source, { sourceType: "unambiguous", plugins: /\.[jt]sx$/.test(filename) ? [typescript, "jsx"] : [typescript], sourceFilename: filename });
    const result: Dependency[] = [];
    function add(node: unknown, typeOnly = false) {
        let literal = node as Ast | undefined;
        while (literal && ["TSAsExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(literal.type))
            literal = literal.expression as Ast;
        if (literal?.type === "StringLiteral")
            result.push({ specifier: String(literal.value), typeOnly });
        else
            throw new Error(`${filename}: nonliteral import/require needs explicit dependency review`);
    }
    function visit(node: unknown) {
        if (!node || typeof node !== "object")
            return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        const n = node as Ast;
        if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(n.type) && n.source) {
            const specs = n.specifiers as Ast[] | undefined;
            add(n.source, n.importKind === "type" || n.exportKind === "type" || Boolean(specs?.length && specs.every(s => s.importKind === "type" || s.exportKind === "type")));
        }
        else if (n.type === "TSImportType")
            add(n.source, true);
        else if (n.type === "TSExternalModuleReference")
            add(n.expression);
        else if (n.type === "ImportExpression")
            add(n.source);
        else if (n.type === "CallExpression") {
            const callee = n.callee as Ast;
            if (callee.type === "Import" || (callee.type === "Identifier" && callee.name === "require")) {
                add((n.arguments as Ast[])[0]);
            }
        }
        for (const [key, value] of Object.entries(n))
            if (!["loc", "comments", "tokens"].includes(key))
                visit(value);
    }
    visit(ast);
    for (const comment of (ast.comments ?? []) as Array<{ type: string; value: string }>) {
        const reference = comment.type === "CommentLine" && comment.value.match(/^\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/);
        if (reference)
            result.push({ specifier: reference[1], typeOnly: true });
    }
    return result;
}
const SOURCE = /\.[cm]?[jt]sx?$/;
const EXCLUDED = /\.(test|spec|stories)\.[cm]?[jt]sx?$/;
/**
 * Production source under `dir`: implementation files and, with
 * `declarations`, hand-written `.d.ts` files too (tests, stories and fixtures
 * are not part of the dependency graph).
 */
export function sourceFiles(dir: string, { declarations = false } = {}): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (["node_modules", "__tests__", "__mocks__"].includes(entry.name))
            return [];
        const file = join(dir, entry.name);
        if (entry.isDirectory())
            return sourceFiles(file, { declarations });
        return SOURCE.test(file) && !EXCLUDED.test(file) && (declarations || !isDeclaration(file)) ? [file] : [];
    });
}
export type Paths = Record<string, string[]>;
export function resolveDependency(file: string, spec: string, root: string, paths: Paths): string | undefined {
    const candidates: string[] = [];
    if (spec.startsWith("."))
        candidates.push(resolve(dirname(file), spec));
    for (const [pattern, targets] of Object.entries(paths)) {
        const [prefix, suffix] = pattern.split("*");
        const matches = suffix === undefined ? spec === prefix : spec.startsWith(prefix) && spec.endsWith(suffix);
        if (matches && targets.some(t => t.includes("node_modules/")))
            return;
        if (matches)
            for (const target of targets)
                candidates.push(resolve(root, target.replaceAll("*", spec.slice(prefix.length, suffix ? -suffix.length : undefined))));
    }
    for (const candidate of candidates) {
        const stem = /\.[cm]?jsx?$/.test(candidate) ? candidate.slice(0, -extname(candidate).length) : candidate;
        const found = [candidate, ...[".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.d.ts", "/index.js"].map(e => stem + e)].find(f => existsSync(f) && SOURCE.test(f));
        if (found)
            return found;
    }
    if (candidates.length && !/\.(css|svg|png|jpg|json)$/.test(spec))
        throw new Error(`${file}: unresolved local dependency ${spec}`);
}
/** An application (or package) directory and the alias map its files resolve with. */
export type Context = {
    root: string;
    paths: Paths;
};
export function contextOf(root: string): Context {
    const config = join(root, "tsconfig.json");
    return { root, paths: existsSync(config) ? readPaths(config) : {} };
}
const within = (dir: string, file: string) => file === dir || file.startsWith(dir + sep);
/**
 * Every production file an application can reach, with its local edges —
 * keyed by path relative to `repoRoot`.
 *
 * Roots are each application's `src/` and each shared package under
 * `packagesDir`. From a root, every resolved local target that is not under
 * `node_modules` is traversed in turn, with the alias map of the application
 * that reached it, so shared code outside the four `src/` trees (the
 * `packages/` sources, a file one application borrows from another) is
 * checked rather than being an edge into nothing. A package is also
 * enumerated directly, under the alias maps of the applications that map a
 * path into it (or its own, if none does), so a cycle inside a package that
 * no application imports yet still fails. A file reached under several alias
 * maps keeps the union of its edges: an extra edge can only find more cycles.
 */
export function dependencyGraph(repoRoot: string, apps: string[], packagesDir = "packages"): Map<string, string[]> {
    const contexts = apps.map(app => contextOf(join(repoRoot, app)));
    const queue: Array<{ file: string; context: Context }> = [];
    for (const context of contexts)
        for (const file of sourceFiles(join(context.root, "src"), { declarations: true }))
            queue.push({ file, context });
    const packagesRoot = join(repoRoot, packagesDir);
    for (const entry of existsSync(packagesRoot) ? readdirSync(packagesRoot, { withFileTypes: true }) : []) {
        if (!entry.isDirectory())
            continue;
        const pkg = join(packagesRoot, entry.name);
        const consumers = contexts.filter(c => Object.values(c.paths).flat().some(t => within(pkg, resolve(c.root, t.replaceAll("*", "")))));
        for (const context of consumers.length ? consumers : [contextOf(pkg)])
            for (const file of sourceFiles(pkg, { declarations: true }))
                queue.push({ file, context });
    }
    const edges = new Map<string, Set<string>>();
    const visited = new Set<string>();
    for (let next = queue.shift(); next; next = queue.shift()) {
        const { file, context } = next;
        const key = `${context.root}\0${file}`;
        if (visited.has(key))
            continue;
        visited.add(key);
        const targets = edges.get(relative(repoRoot, file)) ?? new Set<string>();
        edges.set(relative(repoRoot, file), targets);
        for (const dependency of dependencies(readFileSync(file, "utf8"), file)) {
            const target = resolveDependency(file, dependency.specifier, context.root, context.paths);
            if (!target || !within(repoRoot, target) || target.split(sep).includes("node_modules"))
                continue;
            targets.add(relative(repoRoot, target));
            queue.push({ file: target, context });
        }
    }
    return new Map([...edges].sort(([a], [b]) => a.localeCompare(b)).map(([file, targets]) => [file, [...targets].sort()]));
}
/** Strongly connected components, including self imports. */
export function cycles(graph: Map<string, string[]>): string[][] {
    let index = 0;
    const indices = new Map<string, number>(), lows = new Map<string, number>(), active = new Set<string>(), stack: string[] = [], result: string[][] = [];
    function visit(file: string) {
        indices.set(file, index);
        lows.set(file, index++);
        stack.push(file);
        active.add(file);
        for (const dep of graph.get(file) ?? []) {
            if (!graph.has(dep))
                continue;
            if (!indices.has(dep)) {
                visit(dep);
                lows.set(file, Math.min(lows.get(file)!, lows.get(dep)!));
            }
            else if (active.has(dep))
                lows.set(file, Math.min(lows.get(file)!, indices.get(dep)!));
        }
        if (lows.get(file) === indices.get(file)) {
            const group: string[] = [];
            let member: string;
            do {
                member = stack.pop()!;
                active.delete(member);
                group.push(member);
            } while (member !== file);
            if (group.length > 1 || graph.get(file)?.includes(file))
                result.push(group.sort());
        }
    }
    for (const file of graph.keys())
        if (!indices.has(file))
            visit(file);
    return result.sort((a, b) => a[0].localeCompare(b[0]));
}
// Babel's object-expression parser accepts JSONC comments and trailing commas.
export function readPaths(config: string): Paths {
    const ast = parse(`(${readFileSync(config, "utf8")})`);
    function value(n: any): any {
        if (n.type === "ObjectExpression")
            return Object.fromEntries(n.properties.map((p: any) => [p.key.value ?? p.key.name, value(p.value)]));
        if (n.type === "ArrayExpression")
            return n.elements.map(value);
        return n.value;
    }
    return value((ast.program.body[0] as any).expression).compilerOptions?.paths ?? {};
}
