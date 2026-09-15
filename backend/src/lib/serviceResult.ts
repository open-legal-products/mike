// Shared contract between service functions and route handlers.
//
// A service function never touches `req`/`res`. It returns either a success
// value or a `ServiceFailure` — a small discriminated union naming WHY the
// operation could not be completed. The route handler maps that failure onto
// an HTTP response with `sendServiceFailure`, so the status-code policy lives
// in exactly one place and every module speaks the same vocabulary:
//
//   validation  → 400   the caller's input was malformed
//   forbidden   → 403   the caller is known and explicitly not allowed
//   not_found   → 404   the resource does not exist OR the caller may not
//                       know it exists (the default for authorization gaps,
//                       so a 403 never leaks a foreign id)
//   conflict    → 409   the operation is valid but the current state rejects it
//   unavailable → 503   a dependency (storage, provider) is not configured
//   error       → 500   an unexpected failure; the raw error is logged by
//                       `sendInternalError` and never sent to the client
//
// Modules that predate this file carry their own `kind` strings; new
// services should use these. `failure()` is the constructor, `isFailure()`
// the narrowing guard for callers that compose several service calls.

import type { Response } from "express";
import { sendInternalError } from "./httpError";

export type ServiceFailureKind =
  | "validation"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "error";

export type ServiceFailure =
  | {
      ok: false;
      kind: Exclude<ServiceFailureKind, "error">;
      detail: string;
      /** Optional machine-readable code surfaced to the client. */
      code?: string;
    }
  | { ok: false; kind: "error"; error: unknown };

export type ServiceResult<T> = { ok: true; data: T } | ServiceFailure;

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function failure(
  kind: Exclude<ServiceFailureKind, "error">,
  detail: string,
  code?: string,
): ServiceFailure {
  return code ? { ok: false, kind, detail, code } : { ok: false, kind, detail };
}

export function internalFailure(error: unknown): ServiceFailure {
  return { ok: false, kind: "error", error };
}

export function isFailure<T>(
  result: ServiceResult<T>,
): result is ServiceFailure {
  return result.ok === false;
}

const STATUS_FOR_KIND: Record<Exclude<ServiceFailureKind, "error">, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

/** Map a service failure onto the HTTP response. Returns `res` for chaining. */
export function sendServiceFailure(
  res: Response,
  failure: ServiceFailure,
): Response {
  if (failure.kind === "error") return sendInternalError(res, failure.error);
  // `code` first: that is the key order the pre-existing handlers emitted.
  return res.status(STATUS_FOR_KIND[failure.kind]).json({
    ...(failure.code ? { code: failure.code } : {}),
    detail: failure.detail,
  });
}
