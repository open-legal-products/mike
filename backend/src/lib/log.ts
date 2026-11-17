// Shared logging helpers. Three modules carried a byte-identical copy of
// `devLog` (a fourth, lib/chat/types.ts, exported the copy the chat tree
// imports); this is the single definition they all use.

import { inspect } from "node:util";
import { diagnosticErrorTags } from "./observability/sentryPrivacy";

// Registry markers also match errors from another copy of the SDK.
const AI_SDK_ERROR = Symbol.for("vercel.ai.error");
const AI_GATEWAY_ERROR = Symbol.for("vercel.ai.gateway.error");

/** Provider errors and their causes can contain prompts or model output. */
export function installErrorLogRedaction(): void {
  Object.defineProperty(Error.prototype, inspect.custom, {
    value(this: Error & { [AI_SDK_ERROR]?: boolean; [AI_GATEWAY_ERROR]?: boolean }) {
      if (this[AI_SDK_ERROR] === true || this[AI_GATEWAY_ERROR] === true) {
        return `AI provider error ${inspect(diagnosticErrorTags(this))}`;
      }
      return this;
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
