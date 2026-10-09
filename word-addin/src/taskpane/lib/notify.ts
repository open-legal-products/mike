/**
 * How the task pane tells the user something failed.
 *
 * `describeError` (shared with the web app) decides *what* to say; this
 * module decides *how* the add-in says it: a toast with an honest "Retry"
 * and, for failures the user cannot fix themselves, a "Contact support"
 * ACTION that copies the diagnostics and opens the pre-filled support email
 * (see ./supportHandoff) — a plain `mailto:` LINK does nothing in desktop
 * Word, which is why it is an action and not an anchor.
 *
 * Mirrors frontend/src/app/lib/userFacingError.ts so a failure reads the
 * same in Word as it does in the browser. Screens must never render a raw
 * `error.message` from the API, a stream, or Office.js.
 */
import {
  buildSupportMailto,
  describeError,
  type DescribeErrorOptions,
  type UserFacingError,
} from "@mike/user-error";
import { showToast, type ToastAction } from "@mike/toast-store";
import { SESSION_CHECK_FAILED_MESSAGE } from "./sessionRefresh";
import { openExternalUrl } from "./openExternalUrl";
import {
  buildSupportDiagnostics,
  supportHandoffResult,
  type SupportErrorFields,
} from "./supportHandoff";

export {
  SUPPORT_EMAIL,
  UserVisibleError,
  buildSupportMailto,
  describeError,
  isAbortError,
  isNetworkError,
  type UserErrorKind,
  type UserFacingError,
} from "@mike/user-error";

/** Which client the support email came from. */
export const SUPPORT_PRODUCT = "word-addin";

export interface NotifyErrorOptions extends DescribeErrorOptions {
  /** Re-run the failed action. Offered only when a retry is honest. */
  onRetry?: () => void | Promise<void>;
  /** Collapse repeats (polling loops, autosave) into one toast. */
  dedupeKey?: string;
  /** Force the support link on or off regardless of classification. */
  support?: boolean;
  /** Extra actions beyond Retry. */
  actions?: ToastAction[];
  /** Extra text for the support email body, e.g. which document. */
  supportNote?: string;
  /** Short screen name, e.g. "Workflows". Falls back to the pane URL. */
  page?: string;
}

/** The pre-filled support email for a failure seen in the task pane. */
export function supportMailtoFor(
  error: Pick<
    UserFacingError,
    "title" | "message" | "kind" | "status" | "code" | "requestId"
  >,
  options: { note?: string; page?: string } = {},
): string {
  return buildSupportMailto(error, {
    page:
      options.page ??
      (typeof window !== "undefined" ? window.location.href : undefined),
    product: SUPPORT_PRODUCT,
    note: options.note,
  });
}

/**
 * Hand a failure to a human: copy the diagnostics, open the pre-filled email.
 *
 * The mailbox is the destination, not the web app's /support form — that form
 * posts to a route the backend does not mount, so every submission fails.
 *
 * Both steps can be refused inside a Word webview (a clipboard without
 * permission, a host that blocks navigation), so each is attempted
 * independently and the user is told what actually happened. If neither
 * worked they still get the address and the block, on screen, to copy by hand.
 */
export async function handOffToSupport(
  error: SupportErrorFields,
  options: { note?: string; page?: string } = {},
): Promise<void> {
  const page =
    options.page ??
    (typeof window !== "undefined" ? window.location.href : undefined);
  const details = buildSupportDiagnostics(error, {
    note: options.note,
    page,
    product: SUPPORT_PRODUCT,
  });

  let copied = false;
  try {
    await navigator.clipboard.writeText(details);
    copied = true;
  } catch {
    // No clipboard permission in this host. The draft still carries the
    // details, and the both-refused path puts them on screen.
  }

  // `openExternalUrl` rather than an anchor: desktop Word ignores a link out
  // of the pane but honours Office's openBrowserWindow.
  const opened = openExternalUrl(
    supportMailtoFor(error, { note: options.note, page }),
  );

  const outcome = supportHandoffResult({ copied, opened, details });
  if (outcome.details) {
    // Imported here, not at the top of the file. `tsconfig.json` maps "react"
    // onto `@types/react/index.d.ts` so the webpack build type-checks, and
    // Playwright's loader honours that mapping at RUNTIME: a top-level
    // `import ... from "react"` makes every Node-side spec that reaches this
    // module (e2e/sse.spec.ts does, via api/mikeApi) try to execute a
    // declaration file and die. Nothing else in this module needs React.
    const { createElement } = await import("react");
    showToast({
      tone: "info",
      title: outcome.message,
      // Selectable, and sticky: the user is copying this by hand.
      message: createElement(
        "pre",
        {
          className:
            "mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words text-[11px] leading-4",
        },
        outcome.details,
      ),
      durationMs: null,
      dedupeKey: "support-details",
    });
    return;
  }
  if (outcome.tone === "success") {
    notifySuccess(outcome.message);
    return;
  }
  notifyInfo(outcome.message);
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
    actions.push({
            label: "Retry",
            onClick: async () => {
                try {
                    await options.onRetry?.();
                } catch (retryError) {
                    notifyError(retryError, options);
                }
            },
        });
  }
  const wantsSupport = options.support ?? described.supportable;
  if (wantsSupport) {
    // An ACTION, not a link: desktop Word refuses to follow a `mailto:`
    // anchor out of the pane, so the old link did nothing at all there.
    actions.push({
      label: "Contact support",
      keepOpen: true,
      onClick: () =>
        handOffToSupport(described, {
          note: options.supportNote,
          page: options.page,
        }),
    });
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

/**
 * One deduped toast when the backend says the session is gone and a refresh
 * could not bring it back. No "Retry": there is nothing to retry until the
 * user signs in again.
 */
export function notifySessionExpired(): void {
  showToast({
    tone: "error",
    title: "Sign in required",
    message: "Your session has expired. Sign in again to continue.",
    dedupeKey: "session-expired",
  });
}

/**
 * The refresh never reached the backend, so nothing is known about the
 * session. Do NOT say it expired: the pane is probably still signed in and
 * the user has a connection to fix, not a password to type. `onRetry`
 * re-checks the session.
 */
export function notifySessionCheckFailed(
  onRetry?: () => void | Promise<void>,
): void {
  showToast({
    tone: "error",
    title: "Connection problem",
    message: SESSION_CHECK_FAILED_MESSAGE,
    actions: onRetry ? [{ label: "Retry", onClick: onRetry }] : [],
    dedupeKey: "session-check-failed",
  });
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
