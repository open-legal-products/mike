// Shared logging helpers. Three modules carried a byte-identical copy of
// `devLog` (a fourth, lib/chat/types.ts, exported the copy the chat tree
// imports); this is the single definition they all use.

import { inspect } from "node:util";
import { diagnosticErrorTags } from "./observability/sentryPrivacy";

// Registry markers also match errors from another copy of the SDK.
const AI_SDK_ERROR = Symbol.for("vercel.ai.error");
const AI_GATEWAY_ERROR = Symbol.for("vercel.ai.gateway.error");

// An SDK class name such as AI_JSONParseError; anything else is not printed.
const SDK_ERROR_NAME = /^[A-Za-z_]{1,64}$/;

/**
 * A log-safe stand-in for an AI SDK or gateway error, or undefined for any
 * other value. Provider errors and their causes can contain prompts, model
 * output, headers and request URLs, so only the class name and allowlisted
 * diagnostic tags survive.
 */
export function redactedProviderError(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const marked = error as Record<symbol, unknown>;
  if (marked[AI_SDK_ERROR] !== true && marked[AI_GATEWAY_ERROR] !== true) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  const label =
    typeof name === "string" && SDK_ERROR_NAME.test(name)
      ? `AI provider error ${name}`
      : "AI provider error";
  return `${label} ${inspect(diagnosticErrorTags(error))}`;
}

/** Provider errors and their causes can contain prompts or model output. */
export function installErrorLogRedaction(): void {
  Object.defineProperty(Error.prototype, inspect.custom, {
    value(this: Error) {
      return redactedProviderError(this) ?? this;
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

export type LogLevel = "info" | "warn";
/** Values that may leave the process: numbers, booleans and identifier-shaped strings. */
export type LogAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Where structured logs and metrics go besides this process's own output.
 * lib/observability/sentry.ts installs one when SENTRY_LOGS=on; without it
 * everything below only prints.
 */
export type LogForwarder = {
  log(level: LogLevel, body: string, attributes: LogAttributes): void;
  metric(name: string, value: number, attributes: LogAttributes): void;
};
let forwarder: LogForwarder | null = null;

export function setLogForwarder(next: LogForwarder | null): void {
  forwarder = next;
}

function forward(level: LogLevel, body: string, attributes: LogAttributes): void {
  if (!forwarder) return;
  try {
    forwarder.log(level, body, attributes);
  } catch {
    // A log that cannot be forwarded must not fail the work it describes.
  }
}

/**
 * Send one structured log to the forwarder without printing it. `scope` and
 * `message` must be literals in the source: they are the only prose that
 * leaves the process, and backend/src/__tests__/logContract.test.ts checks
 * every call. Put anything that varies in `attributes`.
 */
export function forwardLogEvent(
  level: LogLevel,
  scope: string,
  message: string,
  attributes: LogAttributes = {},
): void {
  forward(level, `[${scope}] ${message}`, attributes);
}

/** Add to a counter in the forwarder. `name` must be a literal in the source. */
export function countMetric(
  name: string,
  value: number,
  attributes: LogAttributes = {},
): void {
  if (!forwarder) return;
  try {
    forwarder.metric(name, value, attributes);
  } catch {
    // As above.
  }
}

/**
 * One structured log: printed as `[scope] message`, then the attributes and
 * any `detail`, and forwarded with its attributes. `detail` (an error, a
 * path, free text) is printed only; it never leaves the process.
 */
export function logEvent(
  level: LogLevel,
  scope: string,
  message: string,
  attributes?: LogAttributes,
  ...detail: unknown[]
): void {
  const line = `[${scope}] ${message}`;
  const print = level === "warn" ? console.warn : console.log;
  if (attributes && Object.keys(attributes).length) print(line, attributes, ...detail);
  else print(line, ...detail);
  forward(level, line, attributes ?? {});
}

/** A log line with values in it: what to print, and what may leave. */
export type LogTemplate = { readonly printed: string; readonly template: string };

/**
 * Tag for a log line that interpolates values:
 *
 *   log.warn(tpl`[queue] redis still unreachable after ${minutes} minutes`)
 *
 * prints the line as written and forwards its source text with `{}` where
 * each value was ("[queue] redis still unreachable after {} minutes"). The
 * values themselves are printed only.
 */
export function tpl(strings: TemplateStringsArray, ...values: unknown[]): LogTemplate {
  return {
    printed: String.raw({ raw: strings }, ...values),
    template: strings.join("{}"),
  };
}

function write(level: LogLevel, first: string | LogTemplate, rest: unknown[]): void {
  const print = level === "warn" ? console.warn : console.log;
  if (typeof first === "string") {
    const [message, ...detail] = rest;
    const line = `[${first}] ${String(message)}`;
    print(line, ...detail);
    forward(level, line, {});
    return;
  }
  print(first.printed, ...rest);
  forward(level, first.template, {});
}

type Write = {
  (scope: string, message: string, ...detail: unknown[]): void;
  (line: LogTemplate, ...detail: unknown[]): void;
};

/**
 * The backend's logger. `log.warn("dbq", "poll failed", error)` prints
 * exactly what `console.warn("[dbq] poll failed", error)` did and forwards
 * the scope and message; `detail` is printed only. A line with values in it
 * takes a `tpl` template instead. Errors that need attention still go to
 * reportError or console.error, which Sentry files as error events.
 */
export const log: { info: Write; warn: Write } = {
  info: (first: string | LogTemplate, ...rest: unknown[]) => write("info", first, rest),
  warn: (first: string | LogTemplate, ...rest: unknown[]) => write("warn", first, rest),
};

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
