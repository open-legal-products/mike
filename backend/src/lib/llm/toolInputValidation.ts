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
    validator = compile(parameters, {
      draft: draftOf(parameters),
      // A dangling $ref fails only the values at that place.
      unresolvedRefs: "reject",
    });
  } catch {
    validator = null;
    if (!warnedUncompilable.has(toolName)) {
      warnedUncompilable.add(toolName);
      console.warn(
        `[tool-input] the schema of ${toolName} does not compile; its calls are not validated`,
      );
    }
  }
  compiled.set(parameters, validator);
  return validator;
}

function describePath(path: string): string {
  return path === "" ? "(arguments)" : path;
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
    const result = validator.validate(value);
    // The value goes on unchanged: the dispatcher normalises it as before.
    const unchanged = value as Record<string, unknown>;
    if (result.ok) return { success: true, value: unchanged };
    if (mode === "log") {
      const where = result.errors
        .slice(0, MAX_REPORTED_ERRORS)
        .map((e) => `${describePath(e.path)} ${e.keyword}`)
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

/**
 * The checker for one model call. pi-schema is an ES module and the backend
 * compiles to CommonJS, so it loads through import(), as the AI SDK does.
 */
export async function loadToolInputChecker(
  mode: ToolInputValidationMode = toolInputValidationMode(),
): Promise<ToolInputChecker> {
  if (mode === "off") return () => undefined;
  const { compile } = await import("@earendil-works/pi-schema");
  return (toolName, parameters) =>
    buildToolInputCheck(compile, toolName, parameters, mode);
}
