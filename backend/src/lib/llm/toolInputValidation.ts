import type * as PiSchema from "@earendil-works/pi-schema" with {
  "resolution-mode": "import",
};

/**
 * Checks a model's tool-call arguments against the tool's JSON Schema before
 * the call is dispatched. The AI SDK parses arguments as JSON but, given a
 * plain `jsonSchema()` with no validator, never checks them against the
 * schema, so every tool has had to defend itself against a missing field or a
 * wrongly typed one.
 *
 * TOOL_INPUT_VALIDATION selects what a mismatch does:
 * - `log` (default): the call runs exactly as before; the mismatch is logged
 *   at warn level with the failing paths and keywords only (never values).
 * - `enforce`: the call never runs. The SDK answers it with an error naming
 *   each failing path, and the model can correct the call in its next step.
 * - `off`: no check at all.
 *
 * Validation is strict: nothing is coerced (pi-schema's coercion would turn
 * a null into the string "null"). A schema that does not compile (an MCP
 * server's, say) leaves that tool unchecked rather than unusable.
 *
 * The check must never cost a turn. Regular expressions from a schema are not
 * run (see withoutPatterns), and a checker that fails to load or throws
 * leaves the call unchecked.
 */
export type ToolInputValidationMode = "off" | "log" | "enforce";

export function toolInputValidationMode(
  env: NodeJS.ProcessEnv = process.env,
): ToolInputValidationMode {
  const raw = env.TOOL_INPUT_VALIDATION?.trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "log";
}

/** The AI SDK's ValidationResult, restated so this module stays SDK-free. */
export type ToolInputCheckResult =
  | { success: true; value: Record<string, unknown> }
  | { success: false; error: Error };

export type ToolInputCheck = (value: unknown) => ToolInputCheckResult;

/** Builds the check for one tool, or undefined when it is not checked. */
export type ToolInputChecker = (
  toolName: string,
  parameters: unknown,
) => ToolInputCheck | undefined;

/** What the model is told when its arguments do not match the schema. */
export class ToolInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputValidationError";
  }
}

type ValidationError = { path: string; keyword: string; message: string };
type Validator = PiSchema.Validator;
type Compile = typeof PiSchema.compile;

/** At most this many problems are named; the rest are counted. */
const MAX_REPORTED_ERRORS = 5;

// Static tool schemas are module constants, so each compiles once per process.
const compiled = new WeakMap<object, Validator | null>();
const warnedUncompilable = new Set<string>();

const warnedBroken = new Set<string>();

function warnOnce(seen: Set<string>, toolName: string, line: string) {
  if (seen.has(toolName)) return;
  seen.add(toolName);
  console.warn(line);
}

type Schema = Record<string, unknown>;

const isSchemaObject = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is a subschema, or a list of them. */
const SUBSCHEMAS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "allOf",
  "anyOf",
]);
/**
 * Where accepting more inside can make the whole schema accept less, so a
 * pattern cannot simply be dropped. `$ref` is here because its target may sit
 * under any of the others.
 */
const NOT_LOOSENABLE = new Set([
  "not",
  "if",
  "then",
  "else",
  "oneOf",
  "contains",
  "dependencies",
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
]);

type Stripped = { schema: unknown; patterns: boolean; notLoosenable: boolean };

/** Whether a pattern keyword may sit anywhere inside; errs towards yes. */
function mentionsPattern(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsPattern);
  if (!isSchemaObject(value)) return false;
  return Object.entries(value).some(
    ([key, inner]) =>
      key === "pattern" || key === "patternProperties" || mentionsPattern(inner),
  );
}

function stripPatterns(schema: unknown, found: Omit<Stripped, "schema">): unknown {
  if (Array.isArray(schema)) return schema.map((item) => stripPatterns(item, found));
  if (!isSchemaObject(schema)) return schema;
  const out: Schema = {};
  let droppedPatternProperties = false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern") {
      found.patterns = true;
    } else if (key === "patternProperties") {
      found.patterns = true;
      droppedPatternProperties = true;
    } else if (SCHEMA_MAPS.has(key) && isSchemaObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, stripPatterns(sub, found)]),
      );
    } else if (SUBSCHEMAS.has(key)) {
      out[key] = stripPatterns(value, found);
    } else {
      if (NOT_LOOSENABLE.has(key)) {
        found.notLoosenable = true;
        if (mentionsPattern(value)) found.patterns = true;
      }
      out[key] = value;
    }
  }
  // Names the dropped patterns allowed must not now count as "additional".
  if (droppedPatternProperties) {
    delete out.additionalProperties;
    delete out.unevaluatedProperties;
  }
  return out;
}

/**
 * The schema without `pattern` and `patternProperties`, or null when they
 * cannot be dropped safely. A connector's schema is another party's input and
 * its arguments are the model's, so running its regular expressions on this
 * thread would let one catastrophic pattern stall every request. Dropping
 * them only ever accepts more, except beneath the NOT_LOOSENABLE keywords; a
 * schema that has both is left unchecked.
 */
export function withoutPatterns(schema: Schema): Schema | null {
  const found = { patterns: false, notLoosenable: false };
  const stripped = stripPatterns(schema, found) as Schema;
  if (!found.patterns) return schema;
  return found.notLoosenable ? null : stripped;
}

function draftOf(schema: Record<string, unknown>): "2020-12" | "7" {
  const declared = schema.$schema;
  return typeof declared === "string" && /draft-0[4-7]/.test(declared)
    ? "7"
    : "2020-12";
}

function validatorFor(
  compile: Compile,
  toolName: string,
  parameters: Record<string, unknown>,
): Validator | null {
  const cached = compiled.get(parameters);
  if (cached !== undefined) return cached;
  let validator: Validator | null;
  try {
    const checkable = withoutPatterns(parameters);
    if (!checkable) throw new Error("patterns cannot be dropped");
    validator = compile(checkable, {
      draft: draftOf(parameters),
      // A dangling $ref fails only the values at that place.
      unresolvedRefs: "reject",
    });
  } catch {
    validator = null;
    warnOnce(
      warnedUncompilable,
      toolName,
      `[tool-input] the schema of ${toolName} cannot be checked; its calls are not validated`,
    );
  }
  compiled.set(parameters, validator);
  return validator;
}

function describePath(path: string): string {
  return path === "" ? "(arguments)" : path;
}

/**
 * The path for a log line: only names the schema itself declares. Any other
 * segment is a key the model wrote, which may be a client's words, and is
 * logged as `*`.
 */
export function loggablePath(schema: unknown, path: string): string {
  if (path === "") return describePath(path);
  let at: unknown = schema;
  const shown = path
    .slice(1)
    .split("/")
    .map((escaped) => {
      const segment = escaped.replace(/~1/g, "/").replace(/~0/g, "~");
      const here = isSchemaObject(at) ? at : {};
      const properties = isSchemaObject(here.properties) ? here.properties : {};
      if (Object.hasOwn(properties, segment)) {
        at = properties[segment];
        return escaped;
      }
      if (Array.isArray(here.required) && here.required.includes(segment)) {
        at = undefined;
        return escaped;
      }
      if (/^\d+$/.test(segment) && (here.items !== undefined || here.prefixItems !== undefined)) {
        const tuple = Array.isArray(here.prefixItems)
          ? here.prefixItems
          : Array.isArray(here.items)
            ? here.items
            : undefined;
        at = tuple?.[Number(segment)] ?? (Array.isArray(here.items) ? undefined : here.items);
        return escaped;
      }
      at = here.additionalProperties;
      return "*";
    });
  return `/${shown.join("/")}`;
}

/** The model-facing message: each failing path and why. */
export function describeToolInputErrors(
  toolName: string,
  errors: ReadonlyArray<ValidationError>,
): string {
  const shown = errors
    .slice(0, MAX_REPORTED_ERRORS)
    .map((e) => `${describePath(e.path)}: ${e.message} (${e.keyword})`);
  const more = errors.length - shown.length;
  return (
    `The arguments for ${toolName} do not match its schema: ` +
    shown.join("; ") +
    (more > 0 ? `; and ${more} more` : "") +
    ". Nothing ran. Correct the arguments and call the tool again."
  );
}

/** The check for one tool, given pi-schema's compile. */
export function buildToolInputCheck(
  compile: Compile,
  toolName: string,
  parameters: unknown,
  mode: Exclude<ToolInputValidationMode, "off">,
): ToolInputCheck | undefined {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return undefined;
  }
  const validator = validatorFor(
    compile,
    toolName,
    parameters as Record<string, unknown>,
  );
  if (!validator) return undefined;
  return (value) => {
    // The value goes on unchanged: the dispatcher normalises it as before.
    const unchanged = value as Record<string, unknown>;
    let result: ReturnType<Validator["validate"]>;
    try {
      result = validator.validate(value);
    } catch {
      // A checker that breaks (arguments nested too deeply for it, say) must
      // not take the call down with it.
      warnOnce(
        warnedBroken,
        toolName,
        `[tool-input] the check of ${toolName} failed to run; the call was not validated`,
      );
      return { success: true, value: unchanged };
    }
    if (result.ok) return { success: true, value: unchanged };
    if (mode === "log") {
      const where = result.errors
        .slice(0, MAX_REPORTED_ERRORS)
        .map((e) => `${loggablePath(parameters, e.path)} ${e.keyword}`)
        .join(", ");
      console.warn(
        `[tool-input] ${toolName} was called with arguments that do not match its schema (${where}); TOOL_INPUT_VALIDATION=enforce would refuse it`,
      );
      return { success: true, value: unchanged };
    }
    return {
      success: false,
      error: new ToolInputValidationError(
        describeToolInputErrors(toolName, result.errors),
      ),
    };
  };
}

let warnedUnavailable = false;

/**
 * The checker for one model call. pi-schema is an ES module and the backend
 * compiles to CommonJS, so it loads through import(), as the AI SDK does.
 */
export async function loadToolInputChecker(
  mode: ToolInputValidationMode = toolInputValidationMode(),
): Promise<ToolInputChecker> {
  if (mode === "off") return () => undefined;
  let compile: Compile;
  try {
    ({ compile } = await import("@earendil-works/pi-schema"));
  } catch {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn("[tool-input] pi-schema could not be loaded; tool calls are not validated");
    }
    return () => undefined;
  }
  return (toolName, parameters) =>
    buildToolInputCheck(compile, toolName, parameters, mode);
}
