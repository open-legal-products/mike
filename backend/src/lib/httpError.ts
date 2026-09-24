import type { Response } from "express";
import { reportError, requestRoutePattern } from "./observability/sentry";

export const INTERNAL_ERROR_CODE = "internal_error";
export const RATE_LIMITED_CODE = "rate_limited";

/** Body for a 429 from an application rate limiter. */
export function rateLimitedBody(detail: string): {
  code: typeof RATE_LIMITED_CODE;
  detail: string;
} {
  return { code: RATE_LIMITED_CODE, detail };
}
export const INTERNAL_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

// SQLSTATE (42P01), PostgREST (PGRST205) and errno-style (ECONNREFUSED)
// codes are fixed vocabulary, safe to put in a message. Anything else a
// dependency calls `code` could be free text, so it is left out.
const SAFE_CODE = /^[A-Za-z0-9_]{2,40}$/;

/**
 * Turn a thrown or returned non-Error (a supabase-js `{ code, message,
 * details, hint }`, a string, a storage SDK's plain object) into an Error
 * that is worth reporting:
 *
 * - it has a stack, taken where this is called (or above `boundary`, which
 *   drops the helper frames so the top frame is the code that failed);
 * - the original value is its `cause`, so structured fields such as the
 *   PostgREST/SQLSTATE `code` stay machine-readable for the Sentry privacy
 *   boundary, which extracts an allowlisted `failure_code` from the chain;
 * - its message is fixed text plus, at most, that code. The dependency's own
 *   `message`/`details`/`hint` can quote table names or row values, so they
 *   are never copied into the message; they remain reachable through `cause`
 *   in the server log only.
 */
export function asReportableError(
  value: unknown,
  boundary?: (...args: never[]) => unknown,
): Error {
  if (value instanceof Error) return value;
  let code: unknown;
  try {
    code =
      value && typeof value === "object"
        ? (value as { code?: unknown }).code
        : undefined;
  } catch {
    code = undefined;
  }
  const error = new Error(
    typeof code === "string" && SAFE_CODE.test(code)
      ? `Dependency failure (${code})`
      : "Dependency failure (non-Error value)",
    { cause: value },
  );
  if (boundary) Error.captureStackTrace?.(error, boundary);
  return error;
}

export function sendInternalError(
  res: Response,
  error: unknown,
  status = 500,
): Response {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : null;
  // A caller that passes a raw non-Error would otherwise have the reporter
  // stringify it — `message`, `details` and all — into a stackless Error.
  error = asReportableError(error, sendInternalError);

  // Every unexpected 5xx the API returns passes through here, which makes it
  // THE place a backend bug becomes a Sentry issue. The request id is the
  // same one the client gets in the response body, so a user report ("I got
  // request_id X") finds the exact event. Report before logging: the console
  // bridge then knows this error is already accounted for.
  reportError(error, {
    tags: {
      component: "http",
      http_status: status,
      request_id: requestId,
      http_method: res.req?.method,
      // The mounted route pattern, not the URL: /projects/:projectId groups
      // as one issue instead of one per project.
      http_route: requestRoutePattern(res.req),
    },
    extra: { path: res.req?.originalUrl },
  });

  console.error("[http/internal-error]", {
    requestId,
    method: res.req?.method,
    path: res.req?.originalUrl,
    error: error,
  });

  return res.status(status).json({
    code: INTERNAL_ERROR_CODE,
    detail: INTERNAL_ERROR_MESSAGE,
    ...(requestId ? { request_id: requestId } : {}),
  });
}
