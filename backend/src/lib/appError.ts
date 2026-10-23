import { ERROR_KINDS, type ErrorKind } from "./observability/sentryPrivacy";

export type { ErrorKind };

/**
 * The error our own code throws when it knows what went wrong.
 *
 * Sentry events leave the process through an allowlist that keeps only
 * strings that existed in the source before any user ran it: file paths,
 * identifiers, enum members, ids. A message is built at runtime and can
 * quote a filename or a document, so no message ever leaves; it stays what
 * it always was, text for logs, job rows and tests. What makes an event
 * name a bug is the `kind`: a closed vocabulary member (`ERROR_KINDS` in
 * sentryPrivacy.ts) that the privacy boundary reads off the cause chain into
 * the `error_kind` tag, the title and the fingerprint. One kind, one issue.
 * Codes on the `cause` (a dependency's errno, SQLSTATE or HTTP status) ride
 * along as `failure_code` and `dependency_status` as they already did.
 */
export class AppError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (!(ERROR_KINDS as readonly string[]).includes(kind)) {
      // Unreachable through the type system; guards JS callers and tests.
      throw new TypeError("AppError kind is not in ERROR_KINDS");
    }
    this.kind = kind;
  }
}

/**
 * Give `cause` a kind when it does not have one. An AppError passes through
 * unchanged: the thrower's own kind is more specific than a caller's, and
 * the privacy boundary prefers the deepest kind on the chain anyway.
 */
export function withKind(
  cause: unknown,
  kind: ErrorKind,
  message: string,
): AppError {
  return cause instanceof AppError ? cause : new AppError(kind, message, { cause });
}

/** True when `error`, or any error on its `cause` chain, is an AppError. */
export function findAppError(error: unknown): AppError | null {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    if (current instanceof AppError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
