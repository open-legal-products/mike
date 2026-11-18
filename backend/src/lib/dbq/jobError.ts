import { redactedProviderError } from "../log";

/**
 * A readable reason for a failed job, whatever was thrown.
 *
 * PostgREST failures are plain `{ message, code, … }` objects, not Errors, so
 * `String(err)` records "[object Object]" as a job's last_error and logs the
 * same; an `instanceof Error` narrowing with a fixed fallback loses the
 * reason entirely. Both the runner and the coalescing cleanup handler use
 * this so the row an operator looks at says what actually failed.
 */
export function jobErrorMessage(err: unknown, fallback = "unknown"): string {
  // A provider error's message can quote the prompt or the provider's reply,
  // and this text is both logged and stored as the row's last_error.
  const redacted = redactedProviderError(err);
  if (redacted) return redacted;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(err);
    } catch {
      return fallback;
    }
  }
  if (err === undefined || err === null) return fallback;
  return String(err);
}
