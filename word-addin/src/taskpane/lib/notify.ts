/**
 * How the task pane tells the user something failed.
 *
 * `describeError` (shared with the web app) decides *what* to say; this
 * module decides *how* the add-in says it: a toast with an honest "Retry".
 *
 * Mirrors frontend/src/app/lib/userFacingError.ts so a failure reads the
 * same in Word as it does in the browser. Screens must never render a raw
 * `error.message` from the API, a stream, or Office.js.
 */
import {
  describeError,
  type DescribeErrorOptions,
  type UserFacingError,
} from "@mike/user-error";
import {
  retryToastAction,
  showToast,
  type ToastAction,
} from "@mike/toast-store";

export {
  SUPPORT_EMAIL,
  UserVisibleError,
  describeError,
  isAbortError,
  isNetworkError,
  type UserErrorKind,
  type UserFacingError,
} from "@mike/user-error";

export interface NotifyErrorOptions extends DescribeErrorOptions {
  /** Re-run the failed action. Offered only when a retry is honest. */
  onRetry?: () => void | Promise<void>;
  /** Collapse repeats (polling loops, autosave) into one toast. */
  dedupeKey?: string;
  /** Extra actions beyond Retry. */
  actions?: ToastAction[];
  /** Short screen name, e.g. "Workflows": where the failure was seen. */
  page?: string;
}

/**
 * Show a failure to the user. Returns the description so the caller can
 * also render it inline, or `null` when the failure is a cancellation the
 * user caused and does not need to hear about.
 */
export function notifyError(
  error: unknown,
  options: NotifyErrorOptions = {},
): UserFacingError | null {
  const described = describeError(error, options);
  if (described.kind === "aborted") return null;

  // warn, not error: Sentry's console bridge forwards console.error, and a
  // 4xx or a cancellation the user just saw is not an incident. Real faults
  // were already reported where they were caught (5xx, transport).
  if (process.env.NODE_ENV !== "production") {
    console.warn("[user-error]", described.title, described.cause);
  }

  const actions: ToastAction[] = [...(options.actions ?? [])];
  if (options.onRetry && described.retryable) {
    actions.push(
      retryToastAction(options.onRetry, (retryError) =>
        notifyError(retryError, options),
      ),
    );
  }

  showToast({
    tone: "error",
    title: described.title,
    message: described.message,
    actions,
    dedupeKey: options.dedupeKey,
  });

  return described;
}

export function notifySuccess(message: string, title?: string): string {
  return showToast({ tone: "success", title, message });
}

export function notifyInfo(message: string, title?: string): string {
  return showToast({ tone: "info", title, message });
}

/**
 * The user-facing sentence for a failure, with nothing shown on screen.
 * Use where a screen already has a place to put an inline message.
 */
export function userMessage(
  error: unknown,
  options: DescribeErrorOptions = {},
): string {
  return describeError(error, options).message;
}
