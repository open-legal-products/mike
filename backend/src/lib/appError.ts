import { identifyApplicationError, type ErrorKind } from "./observability/sentryPrivacy";

export type { ErrorKind };

/**
 * The error our own code throws when it knows what went wrong.
 *
 * Sentry events leave the process through an allowlist that keeps only
 * diagnostic labels authored in source, technical codes and safe locations.
 * Names and kinds must never be derived from user or dependency content.
 * Messages can quote filenames or documents, so they stay local to logs,
 * job rows and tests. The `kind` is a static, developer-authored label that
 * the privacy boundary reads off the cause chain into the `error_kind` tag,
 * title and fingerprint. Stack grouping still distinguishes failure sites.
 * Codes on the `cause` (a dependency's errno, SQLSTATE or HTTP status) ride
 * along as `failure_code` and `dependency_status` as they already did.
 */
export class AppError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.kind = kind;
    identifyApplicationError(this, kind);
  }
}

/**
 * Give `cause` a kind when its Error chain does not already carry one.
 * Preserve the original Error, including a plain wrapper around an AppError:
 * its stack and identity remain useful, and the boundary reads the named
 * cause's kind. Non-Errors and unnamed Errors are wrapped once.
 */
export function withKind(
  cause: unknown,
  kind: ErrorKind,
  message: string,
): Error {
  return cause instanceof Error && findAppError(cause)
    ? cause
    : new AppError(kind, message, { cause });
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
