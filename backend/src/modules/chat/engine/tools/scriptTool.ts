import type * as Codemode from "@earendil-works/pi-codemode" with {
  "resolution-mode": "import",
};
import type {
  NormalizedToolCall,
  OpenAIToolSchema,
} from "../../../../lib/llm/types";
import {
  loadToolInputChecker,
  type ToolInputChecker,
} from "../../../../lib/llm/toolInputValidation";
import { toolName } from "./toolSchemas";
import { spotlight } from "../contextBuilders";
import { AppError } from "../../../../lib/appError";
import { reportError } from "../../../../lib/observability/sentry";

/**
 * run_script: the model writes a short JavaScript program that calls the
 * turn's read-only document tools in a loop and returns a compact result, so
 * a question over a whole project costs one model step instead of dozens.
 *
 * The script runs in pi-codemode's QuickJS sandbox on a worker thread. Its
 * only capability is the injected tools: no network, files, timers, process
 * or modules. Every tool call it makes is dispatched exactly like the model's
 * own calls (same dispatcher, same document scope and ownership checks), and
 * only tools on SCRIPT_TOOL_ALLOWLIST that this turn already offers the model
 * are exposed. Nothing that writes, asks the user, or reaches a connector is.
 *
 * Off unless SCRIPT_TOOL=on.
 */
export const SCRIPT_TOOL_NAME = "run_script";

/** Read-only server tools a script may call, when the turn offers them. */
export const SCRIPT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "list_documents",
  "find_documents",
  "find_in_document",
  "read_document",
  "fetch_documents",
  "read_table_cells",
]);

/** Tool calls one script may make. */
export const SCRIPT_MAX_TOOL_CALLS = 200;
/** Wall clock for one script, tool time included. */
export const SCRIPT_TIMEOUT_MS = 120_000;
const SCRIPT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** Scripts running at once in this process; each holds a worker thread. */
export const SCRIPT_MAX_CONCURRENT = 4;
/** Of those, how many one user may hold, so one account cannot take them all. */
export const SCRIPT_MAX_CONCURRENT_PER_USER = 2;
/** What the model gets back, at most. */
export const SCRIPT_MAX_RESULT_CHARS = 40_000;
const MAX_CODE_CHARS = 20_000;

export function scriptToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCRIPT_TOOL?.trim().toLowerCase() === "on";
}

type CodemodeModule = typeof Codemode;
let codemodeModule: Promise<CodemodeModule> | null = null;
let quickjsWasm: Promise<Codemode.CodemodeWasmModule> | null = null;

// pi-codemode is an ES module and the backend compiles to CommonJS. A failed
// load is not kept: the next script tries again.
function loadCodemode(): Promise<CodemodeModule> {
  codemodeModule ??= import("@earendil-works/pi-codemode").catch((error) => {
    codemodeModule = null;
    throw error;
  });
  return codemodeModule;
}

function loadWasm(codemode: CodemodeModule) {
  quickjsWasm ??= codemode.loadQuickJSWasm().catch((error) => {
    quickjsWasm = null;
    throw error;
  });
  // The sandbox awaits it later; a rejection is its to report, not unhandled.
  quickjsWasm.catch(() => undefined);
  return quickjsWasm;
}

let runningWorkers = 0;
const runningByUser = new Map<string, number>();

/** The sandbox itself failed: reported, and the model is told to carry on without it. */
function reportSandboxFailure(cause: unknown) {
  reportError(
    new AppError("chat.script_sandbox_failed", "Script sandbox failed", { cause }),
    { tags: { component: "chat-stream", operation: "chat.script_tool" } },
  );
}

/** The turn's tools a script may call: allowlisted and offered this turn. */
export function scriptInnerTools(activeTools: readonly unknown[]): OpenAIToolSchema[] {
  return activeTools.filter((tool): tool is OpenAIToolSchema => {
    const name = toolName(tool);
    return !!name && SCRIPT_TOOL_ALLOWLIST.has(name);
  });
}

function asCodemodeTools(
  innerTools: readonly OpenAIToolSchema[],
  executeFor: (name: string) => Codemode.CodemodeTool["execute"],
): Codemode.CodemodeTool[] {
  return innerTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
    execute: executeFor(tool.function.name),
  }));
}

const SCRIPT_DESCRIPTION = `Run a short JavaScript program that calls the document tools below in a loop and returns a compact result. Use it when a question needs the same lookup across many documents (for example, "which of these 80 agreements have a change-of-control clause?"), instead of calling the tools one at a time.

The code is the body of an async function: use await and return a JSON-serialisable value. Call tools as \`await tools.<name>(args)\`; what each returns is listed below. A call that fails throws an Error you can catch. Use console.log for progress notes. There is no network, file system, timers or modules. At most ${SCRIPT_MAX_TOOL_CALLS} tool calls and ${SCRIPT_TIMEOUT_MS / 1000} seconds per script.

Return only what you need (document ids, short excerpts, counts), not whole documents. Documents a script reads are not shown to you in full: before quoting or citing a document, read it or search it with the normal tools.

`;

/** What each tool resolves to in a script, as the dispatcher really answers. */
const SCRIPT_TOOL_RETURNS: Record<string, string> = {
  list_documents: "an array of { doc_id, filename, file_type }",
  find_documents:
    "{ ok: true, matches: [{ doc_id, filename, ... }], next_offset, coverage }, or { ok: false, error }",
  find_in_document:
    "{ ok: true, filename, total_matches, returned, truncated, hits: [{ index, excerpt, context }] }, or { ok: false, error }",
  read_document:
    "a string: a short header, then the document's text. Keep it: reading the same document again in one script can return a notice in place of the text",
  fetch_documents:
    "one string holding every requested document, each under a `--- <doc_id> ---` line",
  read_table_cells: "a string: the requested cells as text",
};

function returnsSection(inner: readonly OpenAIToolSchema[]): string {
  const lines = inner
    .map((tool) => tool.function.name)
    .filter((name) => SCRIPT_TOOL_RETURNS[name])
    .map((name) => `- ${name}: ${SCRIPT_TOOL_RETURNS[name]}`);
  return `What the tools return:\n${lines.join("\n")}\n\nAvailable tools:\n\n`;
}


/**
 * The run_script schema for this turn, or null when it is off or there is
 * nothing for a script to call.
 */
export async function scriptToolFor(
  activeTools: readonly unknown[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenAIToolSchema | null> {
  if (!scriptToolEnabled(env)) return null;
  const inner = scriptInnerTools(activeTools);
  if (!inner.length) return null;
  let codemode: CodemodeModule;
  try {
    codemode = await loadCodemode();
  } catch (error) {
    // Without the sandbox the turn goes on with its ordinary tools.
    reportSandboxFailure(error);
    return null;
  }
  const declarations = codemode.renderDeclarations({
    tools: asCodemodeTools(inner, () => () => undefined),
  });
  return {
    type: "function",
    function: {
      name: SCRIPT_TOOL_NAME,
      description: SCRIPT_DESCRIPTION + returnsSection(inner) + declarations,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "The body of an async JavaScript function. Call tools as `await tools.read_document({ doc_id })` and end with `return <value>`.",
            maxLength: MAX_CODE_CHARS,
          },
        },
        required: ["code"],
      },
    },
  };
}

/** Runs one inner tool call through the turn's dispatcher; returns its result text. */
export type ScriptToolDispatch = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
) => Promise<string>;

export type ScriptRunContext = {
  innerTools: readonly OpenAIToolSchema[];
  dispatch: ScriptToolDispatch;
  signal?: AbortSignal;
  /** Whose turn this is, for the per-user limit on running scripts. */
  userId?: string;
  /**
   * The turn's spotlighting nonce. What a script returns is built from
   * document text, so it goes back to the model fenced as untrusted content,
   * and the fences on the tools' own results are removed for the script.
   */
  nonce?: string;
  /** Test seams. */
  limits?: Partial<{
    maxToolCalls: number;
    timeoutMs: number;
    maxConcurrent: number;
    maxConcurrentPerUser: number;
    maxResultChars: number;
  }>;
};

/** A thrown error a script sees: its message only, never internal detail. */
class ScriptToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptToolError";
  }
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * A tool result as the script should see it: without the fences the
 * dispatcher puts around document text for the model. The script's own
 * result is fenced as a whole on its way back.
 */
function unfenced(content: string, nonce: string | undefined): string {
  if (!nonce) return content;
  return content
    .split(`<untrusted-content nonce="${nonce}">\n`)
    .join("")
    .split(`\n</untrusted-content nonce="${nonce}">`)
    .join("");
}

/**
 * The result as the model gets it (`wrap` fences it), or a valid JSON preview
 * of it when that is too long.
 */
function capped(
  text: string,
  max: number,
  wrap: (text: string) => string,
): string {
  // A result already over the limit is not fenced just to be measured:
  // fencing scans it, and it can be as large as the VM's memory.
  if (text.length <= max) {
    const whole = wrap(text);
    if (whole.length <= max) return whole;
  }
  const preview = (chars: number) =>
    wrap(
      JSON.stringify({
        ok: false,
        error: `The script's result is longer than ${max} characters. Return less, for example ids, counts and short excerpts.`,
        preview: text.slice(0, chars),
      }),
    );
  // Escaping and fencing can more than double the preview, so shrink it
  // until the whole fits.
  let chars = Math.max(0, max - 300);
  let out = preview(chars);
  while (out.length > max && chars > 0) {
    chars = Math.max(0, chars - (out.length - max));
    out = preview(chars);
  }
  return out;
}

function failure(
  message: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ ok: false, error: message, ...extra });
}

const ERROR_MESSAGES: Record<Codemode.CodemodeErrorKind, string> = {
  script: "The script threw an error.",
  timeout: "The script ran out of time.",
  aborted: "The script was stopped.",
  sandbox: "The script sandbox failed. Try again, or use the tools directly.",
};

/** Runs a run_script call and returns the tool result the model sees. */
export async function runScriptCall(
  call: NormalizedToolCall,
  context: ScriptRunContext,
): Promise<string> {
  const limits = {
    maxToolCalls: SCRIPT_MAX_TOOL_CALLS,
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxConcurrent: SCRIPT_MAX_CONCURRENT,
    maxConcurrentPerUser: SCRIPT_MAX_CONCURRENT_PER_USER,
    maxResultChars: SCRIPT_MAX_RESULT_CHARS,
    ...context.limits,
  };
  const code = call.input.code;
  if (typeof code !== "string" || !code.trim()) {
    return failure("Pass the script as a non-empty `code` string.");
  }
  if (code.length > MAX_CODE_CHARS) {
    return failure(`The script is longer than ${MAX_CODE_CHARS} characters.`);
  }
  if (!context.innerTools.length) {
    return failure("No tools are available to scripts in this conversation.");
  }

  let codemode: CodemodeModule;
  try {
    codemode = await loadCodemode();
  } catch (error) {
    reportSandboxFailure(error);
    return failure(ERROR_MESSAGES.sandbox);
  }
  // Script calls are new, so they are always held to their schemas.
  const checker: ToolInputChecker = await loadToolInputChecker("enforce");
  const checks = new Map(
    context.innerTools.map((tool) => [
      tool.function.name,
      checker(tool.function.name, tool.function.parameters),
    ]),
  );

  let calls = 0;
  // A dispatcher that is down fails every call of a loop the same way; one
  // report per script says so without spending the day's quota on it.
  let reportedToolFailure = false;
  // One inner call at a time: the dispatcher's per-turn state is not built
  // for concurrent batches, and this bounds a script's load on the database.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const executeFor =
    (name: string): Codemode.CodemodeTool["execute"] =>
    async (args, { signal: ended }) => {
      if (calls >= limits.maxToolCalls) {
        throw new ScriptToolError(
          `This script reached its limit of ${limits.maxToolCalls} tool calls.`,
        );
      }
      calls += 1;
      const input =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      const check = checks.get(name);
      const checked = check?.(input);
      if (checked && !checked.success) {
        throw new ScriptToolError(checked.error.message);
      }
      const callId = `${call.id}:${calls}`;
      let content: string;
      try {
        content = await serial(() => {
          // The script has ended (returned, timed out or was stopped) with
          // this call still queued: it must not run on behind the turn.
          if (ended.aborted) throw new ScriptToolError("The script has ended.");
          return context.dispatch(name, input, callId);
        });
      } catch (error) {
        if (context.signal?.aborted || ended.aborted) throw error;
        // The script is told only that the call failed; the failure itself
        // is reported here, where it stops, as the dispatcher reports its own.
        if (!reportedToolFailure) {
          reportedToolFailure = true;
          reportError(
            error instanceof AppError
              ? error
              : new AppError("chat.tool_failed", "Tool call failed", { cause: error }),
            { tags: { component: "chat-stream", operation: "chat.script_tool" } },
          );
        }
        throw new ScriptToolError(`${name} failed.`);
      }
      return parseToolResult(unfenced(content, context.nonce));
    };

  const TOO_MANY =
    "Too many scripts are running right now. Use the tools directly, or try again shortly.";
  if (runningWorkers >= limits.maxConcurrent) return failure(TOO_MANY);
  const { userId } = context;
  if (userId && (runningByUser.get(userId) ?? 0) >= limits.maxConcurrentPerUser) {
    return failure(
      "You already have scripts running in other conversations. Use the tools directly, or try again shortly.",
    );
  }
  // Set when the limit is reached between the check above and the worker's start.
  let refused = false;

  const sandbox = new codemode.CodemodeSandbox({
    tools: asCodemodeTools(context.innerTools, executeFor),
    timeoutMs: limits.timeoutMs,
    memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
    wasm: loadWasm(codemode),
    acquireWorker: () => {
      if (runningWorkers >= limits.maxConcurrent) {
        refused = true;
        throw new Error("script worker limit reached");
      }
      runningWorkers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        runningWorkers -= 1;
      };
    },
  });

  let result: Codemode.CodemodeResult;
  if (userId) runningByUser.set(userId, (runningByUser.get(userId) ?? 0) + 1);
  try {
    result = await sandbox.execute(code, { signal: context.signal });
  } finally {
    if (userId) {
      const left = (runningByUser.get(userId) ?? 1) - 1;
      if (left > 0) runningByUser.set(userId, left);
      else runningByUser.delete(userId);
    }
    await sandbox.close();
    // Queued calls have been refused by now; the one that was already running
    // finishes before the turn moves on, since the dispatcher's per-turn
    // state is not built for a call running beside the next step.
    await queue;
  }
  if (refused) return failure(TOO_MANY);
  // Built from document text: data for the model, never instructions.
  const fenced = (text: string) =>
    context.nonce ? spotlight(text, context.nonce) : text;

  const output = result.output
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const summary = {
    tool_calls: result.calls.length,
    ...(output ? { output } : {}),
  };
  if (result.ok) {
    return capped(
      JSON.stringify({ ok: true, value: result.value ?? null, ...summary }),
      limits.maxResultChars,
      fenced,
    );
  }
  const { kind } = result.error;
  if (kind === "sandbox") reportSandboxFailure(new Error(result.error.message));
  // A script's own error message is the model's to read: it wrote the code.
  const detail =
    kind === "script"
      ? `${result.error.name ?? "Error"}: ${result.error.message}`
      : undefined;
  return capped(
    failure(ERROR_MESSAGES[kind], {
      ...(detail ? { detail } : {}),
      ...summary,
    }),
    limits.maxResultChars,
    fenced,
  );
}
