// Diagnostics are authored at the source; adding a label needs no central
// registration. This guard catches common accidental data flows. It is not
// whole-program taint analysis: helpers that forward labels still need review.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
// Babel 8 ships ESM only, and this suite compiles as CommonJS: load the parser
// with a dynamic import and take its types in import resolution mode.
import type { ParserPlugin } from "@babel/parser" with { "resolution-mode": "import" };
import type { Node } from "@babel/types" with { "resolution-mode": "import" };
import { beforeAll, describe, expect, it } from "vitest";
import { isDiagnosticLabel } from "../lib/observability/sentryPrivacy";

const ROOT = resolve(__dirname, "../../..");
let parse: typeof import("@babel/parser", { with: { "resolution-mode": "import" } }).parse;
beforeAll(async () => {
  ({ parse } = await import("@babel/parser"));
});
const LABEL_KEYS = new Set(["operation", "component", "stage", "error_kind", "job_kind", "what"]);
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "__tests__"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path)
      : /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path) ? [path] : [];
  });
}
function children(node: Node): Node[] {
  return Object.values(node).flatMap(value => Array.isArray(value) ? value : [value])
    .filter((value): value is Node => value !== null && typeof value === "object" && typeof value.type === "string");
}
function name(node: Node | null | undefined): string | undefined {
  return node?.type === "Identifier" ? node.name : node?.type === "StringLiteral" ? node.value : undefined;
}
function memberName(node: Node): string | undefined {
  return node.type === "MemberExpression" || node.type === "OptionalMemberExpression" ? name(node.property) : name(node);
}
function staticName(node: Node): boolean {
  return node.type === "StringLiteral" || (node.type === "TemplateLiteral" && !node.expressions.length)
    || (node.type === "MemberExpression" && node.object.type === "MetaProperty"
      && node.object.meta.name === "new" && node.object.property.name === "target" && name(node.property) === "name");
}
function unsafeLabel(node: Node): boolean {
  if (node.type === "StringLiteral") return !isDiagnosticLabel(node.value);
  if (node.type === "TemplateLiteral") return node.expressions.length > 0 || !isDiagnosticLabel(node.quasis[0]?.value.cooked);
  if (node.type === "BinaryExpression" && node.operator === "+") return true;
  // Fixed maps and typed helper parameters are allowed. Direct request data
  // and upstream prose are not diagnostic identities.
  if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
      && ["body", "query", "params", "message", "email", "filename", "content", "text", "stack", "name", "title", "url"].includes(name(node.property) ?? "")) return true;
  return children(node).some(child => child.type !== "Identifier" && unsafeLabel(child));
}
function violations(source: string, path = "inline.ts"): string[] {
  // Babel 8 reads `<T>(x) => x` as JSX when the jsx plugin is on, so only
  // .tsx files get it, matching how TypeScript itself parses each extension.
  const plugins: ParserPlugin[] = path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"];
  const tree = parse(source, { sourceType: "unambiguous", plugins });
  const errors: string[] = [];
  const errorBindings = new Set<string>();
  const note = (node: Node, reason: string) => errors.push(`${node.loc?.start.line}: ${reason}`);
  const isError = (node: Node): boolean => node.type === "NewExpression" && /Error$/.test(memberName(node.callee) ?? "");
  function visit(node: Node, inErrorClass = false, inDiagnostics = false) {
    if (node.type === "CallExpression" && ["reportError", "reportFault", "reportFlowFailure", "reportApiFailure", "notifyError", "notifyPartialFailure", "userFacingApiError", "describeError", "reportWordFailure", "bestEffort"].includes(memberName(node.callee) ?? "")) inDiagnostics = true;
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      inErrorClass = /Error$/.test(name(node.id) ?? "") || /Error$/.test(node.superClass ? memberName(node.superClass) ?? "" : "");
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isError(node.init)) errorBindings.add(node.id.name);
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression" && memberName(node.left) === "name") {
      const receiver = node.left.object;
      if ((receiver.type === "ThisExpression" && inErrorClass)
          || (receiver.type === "Identifier" && (errorBindings.has(receiver.name) || /^(?:err|error|failure)$/i.test(receiver.name)))) {
        if (!staticName(node.right)) note(node, "error names must be static; keep runtime data out of diagnostic identity");
      }
    }
    if (inDiagnostics && node.type === "ObjectProperty" && LABEL_KEYS.has(name(node.key) ?? "") && unsafeLabel(node.value)) note(node, "diagnostic labels must be authored in code, not interpolated or copied from runtime data");
    if (inErrorClass && node.type === "ClassProperty" && name(node.key) === "name" && node.value && !staticName(node.value)) note(node, "error names must be static");
    if (node.type === "NewExpression" && memberName(node.callee) === "AppError" && node.arguments[0] && unsafeLabel(node.arguments[0])) note(node, "AppError kind must be a static diagnostic label");
    if (node.type === "CallExpression") {
      const callee = memberName(node.callee);
      if (["setOperation", "markStage"].includes(callee ?? "") && node.arguments[0] && unsafeLabel(node.arguments[0])) note(node, "operation/stage must be a static diagnostic label");
      if (callee === "setTag" && LABEL_KEYS.has(name(node.arguments[0]) ?? "") && node.arguments[1] && unsafeLabel(node.arguments[1])) note(node, "diagnostic scope tags must be authored in code");
      if (node.callee.type === "MemberExpression" && name(node.callee.object) === "Object") {
        if (callee === "assign" && node.arguments[0] && isError(node.arguments[0])) {
          for (const arg of node.arguments.slice(1)) if (arg.type === "ObjectExpression") {
            for (const prop of arg.properties) if (prop.type === "ObjectProperty" && name(prop.key) === "name" && !staticName(prop.value)) note(prop, "assigned error names must be static");
          }
        }
        if (callee === "defineProperty" && name(node.arguments[1]) === "name") {
          const descriptor = node.arguments[2];
          if (descriptor?.type === "ObjectExpression") {
            for (const prop of descriptor.properties) if (prop.type === "ObjectProperty" && name(prop.key) === "value" && !staticName(prop.value)) note(prop, "redefined names must be static");
          }
        }
      }
    }
    if ((node.type === "ObjectMethod" || node.type === "ClassMethod"
        || (node.type === "ObjectProperty" && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.value.type)))
        && node.computed && !staticName(node.key)
        && !(node.key.type === "MemberExpression" && name(node.key.object) === "Symbol")) note(node, "computed function names can expose runtime data in stacks; use a static method");
    for (const child of children(node)) visit(child, inErrorClass, inDiagnostics);
  }
  visit(tree);
  return errors;
}

describe("diagnostic source contract", () => {
  it.each([
    'new AppError("new_feature.unregistered_failure", "Failed", {cause: error})',
    'reportError(error, {tags: {operation: "new_feature.run", stage: "new-stage"}})',
    'class FreshError extends Error { constructor() { super("Failed"); this.name = "FreshError"; } }',
    'class AppError extends Error { constructor() { super("Failed"); this.name = new.target.name; } }',
    'setOperation(GOOGLE_OPERATIONS[provider]);',
    'const domainData = {operation: req.body.operation, component: "Button"};',
  ])("accepts static names and labels without registration: %s", source => expect(violations(source)).toEqual([]));
  it.each([
    'new AppError(`upload.${filename}`, "Failed")',
    'setOperation(req.body.operation)',
    'reportError(error, {tags: {error_kind: error.message}})',
    'class UploadError extends Error { constructor(client) { super(); this.name = client + "Error"; } }',
    'Object.assign(new Error("Failed"), {name: clientName})',
    'class UploadError extends Error { name = clientName; }',
    'scope.setTag("operation", req.body.operation)',
    'Object.defineProperty(handler, "name", {value: clientName})',
    'const actions = {[clientName]() { throw new Error("Failed"); }}',
  ])("rejects runtime diagnostic identity: %s", source => expect(violations(source).length).toBeGreaterThan(0));
  it("checks production source in the backend, web app and Word add-in", () => {
    const paths = ["backend/src", "frontend/src", "word-addin/src"].flatMap(root => files(join(ROOT, root)));
    expect(paths.length).toBeGreaterThan(500);
    const failures = paths.flatMap(path => violations(readFileSync(path, "utf8"), path).map(problem => `${relative(ROOT, path)}:${problem}`));
    expect(failures).toEqual([]);
  });
});
