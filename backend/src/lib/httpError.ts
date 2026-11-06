import type { Response } from "express";
import { reportError, requestRoutePattern } from "./observability/sentry";
import { shouldReportUpstreamFailure } from "./upstreamOutage";
import {
  SCHEMA_OUT_OF_DATE_CODE,
  gateSchemaOutOfDate,
  schemaOutOfDateCode,
} from "./schemaOutOfDate";

// The codes and sentences a client recognises as "already reported server-side"
// live in a dependency-free module (reportedUpstreamCodes.ts) so the frontend
// parity test can import them; re-exported here for the callers that build 503s.
export {
  SCHEMA_OUT_OF_DATE_CODE,
  SCHEMA_OUT_OF_DATE_MESSAGE,
  UPSTREAM_UNAVAILABLE_CODE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
} from "./reportedUpstreamCodes";
import {
  SCHEMA_OUT_OF_DATE_MESSAGE,
  UPSTREAM_UNAVAILABLE_CODE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
} from "./reportedUpstreamCodes";

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

/** Retry-After (seconds) on that 503, as frontend/src/app/api/[...path]/route.ts sends it. */
const UPSTREAM_RETRY_AFTER_SECONDS = "5";


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

// res.locals key set once a request's failure has been sent to Sentry, so
// the response sanitizer (middleware/internalErrorResponse.ts) neither files
// a second event for the same 5xx nor rewrites its fixed public code.
const FAILURE_REPORTED = "failureReported";

/** True when sendInternalError already reported this request's failure. */
export function failureAlreadyReported(res: Response): boolean {
  return res.locals?.[FAILURE_REPORTED] === true;
}

/** A public answer other than the default internal_error/schema pair. */
export interface PublicFailure {
  code: string;
  detail: string;
}

/** What sendInternalError answers and how it reports, when not the default. */
export interface InternalErrorOptions {
  /** The public body instead of internal_error (schema drift always wins). */
  answer?: PublicFailure;
  /**
   * `false`: the failure is a known repeat; log it, do not send it. Read as
   * `!== false`, so leaving it out (or passing undefined) reports.
   */
  report?: boolean;
  /** Names the flow when the request's handler has not set one yet. */
  operation?: string;
  /** Groups the event under a pinned condition instead of the route. */
  fingerprint?: string[];
}

export function sendInternalError(
  res: Response,
  error: unknown,
  status = 500,
  options: InternalErrorOptions = {},
): Response {
  const { answer, operation, fingerprint } = options;
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : null;
  // A caller that passes a raw non-Error would otherwise have the reporter
  // stringify it — `message`, `details` and all — into a stackless Error.
  error = asReportableError(error, sendInternalError);
  // A schema behind the code is an install problem, not a bug in this
  // request: answer 503 with a code the client can recognise instead of an
  // opaque 500, and tell the operator what to do in the server log. Every
  // request to that route fails the same way until the operator migrates,
  // so the report goes through the same once-per-process gate as background
  // drift (lib/schemaOutOfDate.ts), keyed by method and route.
  const schemaCode = schemaOutOfDateCode(error);
  if (schemaCode && status === 500) status = 503;
  const method = res.req?.method;
  // The mounted route pattern, not the URL: /projects/:projectId groups as
  // one issue instead of one per project.
  const route = requestRoutePattern(res.req);
  const drift = schemaCode
    ? gateSchemaOutOfDate(error, { key: `http:${method ?? "?"} ${route ?? "?"}` })
    : null;
  const report = options.report !== false && (drift?.report ?? true);

  // Every unexpected 5xx the API returns passes through here, which makes it
  // THE place a backend bug becomes a Sentry issue. The request id is the
  // same one the client gets in the response body, so a user report ("I got
  // request_id X") finds the exact event. Report before logging: the console
  // bridge then knows this error is already accounted for.
  if (report) {
    reportError(error, {
      tags: {
        component: "http",
        http_status: status,
        request_id: requestId,
        http_method: method,
        http_route: route,
        ...(operation ? { operation } : {}),
      },
      ...(fingerprint ? { fingerprint } : {}),
    });
  }

  if (drift && !drift.report) {
    // The gate logged the first failure of this route with the operator's
    // next step (MIGRATE_HINT) and repeats it hourly with a count; each
    // repeat still leaves one line. console.warn, not console.error: the
    // Sentry console bridge files every console.error it has not seen
    // reported, and repeats are kept out of Sentry on purpose.
    console.warn(
      `[http/schema-out-of-date] ${method ?? "?"} ${route ?? "?"} answered 503 (${drift.code}); ` +
        "already reported, see the [schema-out-of-date] line for what to do.",
    );
  }
  if (report) {
    console.error("[http/internal-error]", {
      requestId,
      method,
      path: res.req?.originalUrl?.split("?")[0],
      error: error,
    });
  }
  // Set for a known repeat too: the response sanitizer must neither report
  // it nor rewrite its public code.
  res.locals[FAILURE_REPORTED] = true;

  const body: PublicFailure = schemaCode
    ? { code: SCHEMA_OUT_OF_DATE_CODE, detail: SCHEMA_OUT_OF_DATE_MESSAGE }
    : (answer ?? { code: INTERNAL_ERROR_CODE, detail: INTERNAL_ERROR_MESSAGE });
  return res.status(status).json({
    ...body,
    ...(requestId ? { request_id: requestId } : {}),
  });
}

/**
 * A dependency (GoTrue, today) could not be reached: 503
 * `upstream_unavailable`. Use it only for failures the user can wait out
 * (lib/authUpstream.ts decides that for auth-js errors); a dependency
 * answering with its own bug stays a 500.
 *
 * Every request fails this way for as long as the outage lasts, so the
 * report is gated per process (lib/upstreamOutage.ts): the first failure of
 * a class is one event, pinned to one `upstream-unavailable` issue whatever
 * route tripped it; repeats are a counted console.warn. `operation` names
 * the flow when the handler that would set it has not run (requireAuth).
 */
export function sendUpstreamUnavailable(
  res: Response,
  error: unknown,
  options: { operation?: string } = {},
): Response {
  const report = shouldReportUpstreamFailure(error);
  // The same hint the Next gateway sends with its upstream_unavailable 503:
  // a client or proxy that honours it waits instead of retrying at once.
  res.set("retry-after", UPSTREAM_RETRY_AFTER_SECONDS);
  return sendInternalError(res, error, 503, {
    answer: { code: UPSTREAM_UNAVAILABLE_CODE, detail: UPSTREAM_UNAVAILABLE_MESSAGE },
    report,
    operation: options.operation,
    fingerprint: ["upstream-unavailable"],
  });
}
