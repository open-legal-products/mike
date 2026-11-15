// Shared logging helpers. Three modules carried a byte-identical copy of
// `devLog` (a fourth, lib/chat/types.ts, exported the copy the chat tree
// imports); this is the single definition they all use.

import { inspect, type InspectOptions } from "node:util";
import { diagnosticErrorTags } from "./observability/sentryPrivacy";

// Every error the AI SDK constructs (APICallError, RetryError,
// TypeValidationError, ...) carries the first registry symbol; the Vercel AI
// Gateway's errors carry the second. Registry symbols match across copies and
// versions of the SDK, so no class has to be imported (the SDK is ESM-only).
const AI_SDK_ERROR_MARKERS = [
  Symbol.for("vercel.ai.error"),
  Symbol.for("vercel.ai.gateway.error"),
];

function isAiSdkError(value: object): boolean {
  return AI_SDK_ERROR_MARKERS.some(
    (marker) => (value as Record<symbol, unknown>)[marker] === true,
  );
}

/** Stack frames only: the header line repeats the message. */
function stackFrames(error: Error): string[] {
  let stack = typeof error.stack === "string" ? error.stack : "";
  const message = typeof error.message === "string" ? error.message : "";
  const end = message ? stack.indexOf(message) : -1;
  if (end >= 0) stack = stack.slice(end + message.length);
  return stack.split("\n").filter((line) => /^\s+at \S/.test(line));
}

const rendering = new WeakSet<object>();

/**
 * How an AI SDK error prints in stdout/stderr. Its own properties carry the
 * request body (the prompt, with document text), the provider's response
 * body, response headers and the endpoint URL, and its message is provider
 * text or, for validation and parse errors, the model's output. Node's
 * console prints all of that, including for an error nested as the `cause`
 * of our own AppError. Keep what identifies the failure: the class, the same
 * fixed codes the Sentry boundary admits (status, provider error type and
 * reason, network code), the stack frames, and what it wraps.
 */
function renderAiSdkError(
  error: Error,
  options: InspectOptions,
  inspectValue: typeof inspect,
): string {
  if (rendering.has(error)) return `[Circular ${error.name}]`;
  rendering.add(error);
  try {
    const tags = diagnosticErrorTags(error);
    const lines = [
      `${error.name} (provider text withheld)${Object.keys(tags).length ? ` ${inspectValue(tags, { ...options, depth: 0, breakLength: Infinity })}` : ""}`,
      ...stackFrames(error),
    ];
    const { cause, lastError, errors } = error as {
      cause?: unknown;
      lastError?: unknown;
      errors?: unknown;
    };
    const nested = { ...options, depth: options.depth == null ? options.depth : options.depth - 1 };
    if (Array.isArray(errors)) lines.push(`  [attempts]: ${errors.length}`);
    for (const [label, value] of [["lastError", lastError], ["cause", cause]] as const) {
      if (value === undefined || value === null) continue;
      lines.push(`  [${label}]: ${inspectValue(value, nested).replaceAll("\n", "\n  ")}`);
    }
    return lines.join("\n");
  } finally {
    rendering.delete(error);
  }
}

/**
 * Redact AI SDK errors wherever the process logs one. Every console.* call
 * (logError below included) formats its arguments with util.inspect, so this
 * hook is the single choke point: no call site has to remember it, and the
 * Error object itself is untouched, so the Sentry console bridge still
 * recognises it. Any other error prints exactly as before (returning `this`
 * tells inspect to use its default formatting). Node's native printer for a
 * crash with no handler does not consult it; with Sentry on, Sentry's handler
 * logs the crash through console.error instead. Installed by src/instrument.ts,
 * the first import of every entrypoint.
 */
export function installErrorLogRedaction(): void {
  Object.defineProperty(Error.prototype, inspect.custom, {
    value: function inspectError(
      this: Error,
      _depth: number,
      options: InspectOptions,
      inspectValue: typeof inspect,
    ) {
      return isAiSdkError(this) ? renderAiSdkError(this, options, inspectValue) : this;
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

/**
 * Exported for call sites that gate WORK (extra lookups, payload assembly)
 * behind dev mode, not just the log line itself.
 */
export const isDev = process.env.NODE_ENV !== "production";

/**
 * Verbose tracing that is only useful while developing. Silent in production,
 * so call sites can log request/response shapes without a runtime cost or a
 * noisy production log.
 */
export const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

/**
 * Always-on error log, tagged with the subsystem that produced it, so a
 * failure can be traced to the subsystem that raised it without every call
 * site inventing its own prefix format.
 */
export function logError(
  scope: string,
  err: unknown,
  ctx?: Record<string, unknown>,
) {
  const tag = `[${scope}]`;
  if (ctx) console.error(tag, err, ctx);
  else console.error(tag, err);
}
