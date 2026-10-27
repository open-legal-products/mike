import { parse } from "@babel/parser";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
export type Dependency = {
    specifier: string;
    typeOnly: boolean;
};
type Ast = {
    type: string;
    [key: string]: unknown;
};
/** Parse syntax, not comments/string contents. Include erased dependencies too. */
export function dependencies(source: string, filename = "source.ts"): Dependency[] {
    const ast = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"], sourceFilename: filename });
    const result: Dependency[] = [];
    function add(node: unknown, typeOnly = false) {
        const literal = node as Ast | undefined;
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
            add(n.argument, true);
        else if (n.type === "TSExternalModuleReference")
            add(n.expression);
        else if (n.type === "ImportExpression")
            add(n.source);
        else if (n.type === "CallExpression") {
            const callee = n.callee as Ast;
            if (callee.type === "Import" || (callee.type === "Identifier" && callee.name === "require")) {
                let argument = (n.arguments as Ast[])[0];
                while (argument && ["TSAsExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(argument.type))
                    argument = argument.expression as Ast;
                add(argument);
            }
        }
        for (const [key, value] of Object.entries(n))
            if (!["loc", "comments", "tokens"].includes(key))
                visit(value);
    }
    visit(ast);
    return result;
}
export function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (["node_modules", "__tests__", "__mocks__"].includes(entry.name))
            return [];
        const file = join(dir, entry.name);
        if (entry.isDirectory())
            return sourceFiles(file);
        return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec|stories|d)\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
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
        const found = [candidate, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map(e => stem + e)].find(f => existsSync(f) && /\.[cm]?[jt]sx?$/.test(f));
        if (found)
            return found;
    }
    if (candidates.length && !/\.(css|svg|png|jpg|json)$/.test(spec))
        throw new Error(`${file}: unresolved local dependency ${spec}`);
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
