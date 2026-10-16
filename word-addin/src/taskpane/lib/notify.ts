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
 * The toast, the Retry and the cancellation rule are the web app's own
 * (`@mike/error-notifier`), so a failure reads the same in Word as it does in
 * the browser; this file adds only what differs in the pane. Screens must
 * never render a raw `error.message` from the API, a stream, or Office.js.
 */
import {
  buildSupportMailto,
  describeError,
  type DescribeErrorOptions,
  type UserFacingError,
} from "@mike/user-error";
import { retryToastAction, showToast } from "@mike/toast-store";
import {
  createErrorNotifier,
  notifyInfo,
  notifySuccess,
  type NotifyErrorOptions as SharedNotifyErrorOptions,
} from "@mike/error-notifier";
import {
  isSessionHandledError,
  retryWhenSessionRecovers,
  SESSION_CHECK_FAILED_MESSAGE,
  SESSION_ERROR_CODES,
  SESSION_EXPIRED_MESSAGE,
} from "./sessionRefresh";
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
export { notifyInfo, notifySuccess } from "@mike/error-notifier";

/** Which client the support email came from. */
export const SUPPORT_PRODUCT = "word-addin";

export interface NotifyErrorOptions extends SharedNotifyErrorOptions {
  /** Short screen name, e.g. "Workflows". Falls back to the pane URL. */
  page?: string;
}

/** Where a failure was seen: the screen name, else the pane URL. */
function supportPage(page?: string): string | undefined {
  return page ?? (typeof window !== "undefined" ? window.location.href : undefined);
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
    page: supportPage(options.page),
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
  const page = supportPage(options.page);
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
    showToast({
      tone: "info",
      title: outcome.message,
      // The toast's plain message; its line breaks would collapse there, so
      // the fields are separated in-line. Sticky: the user is copying this
      // by hand.
      message: outcome.details.split("\n").join(" · "),
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
export const notifyError = createErrorNotifier<NotifyErrorOptions>({
  // A 401 the session layer already handled: its own toast (or the login
  // gate) said what happened, so a second notice would only repeat it with
  // the request's raw "Not authenticated". After an unreachable check the
  // screen's Retry runs once the check succeeds again; an expired session
  // queues nothing, since the sign-out already dropped that session's work.
  beforeShow: (_error, described, options) => {
    if (!isSessionHandledError(described)) return false;
    if (options.onRetry && described.code === SESSION_ERROR_CODES.unreachable) {
      retryWhenSessionRecovers(options.onRetry);
    }
    return true;
  },
  // An ACTION, not a link: desktop Word refuses to follow a `mailto:`
  // anchor out of the pane, so the old link did nothing at all there.
  present: (described, options, wantsSupport) => ({
    actions: wantsSupport
      ? [
          {
            label: "Contact support",
            keepOpen: true,
            onClick: () =>
              handOffToSupport(described, {
                note: options.supportNote,
                page: options.page,
              }),
          },
        ]
      : [],
  }),
});

/**
 * One deduped toast when the backend says the session is gone and a refresh
 * could not bring it back. No "Retry": there is nothing to retry until the
 * user signs in again.
 */
export function notifySessionExpired(): void {
  showToast({
    tone: "error",
    title: "Sign in required",
    message: SESSION_EXPIRED_MESSAGE,
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
    // A re-check that fails outright says so again instead of becoming an
    // unhandled rejection from the click.
    actions: onRetry
      ? [retryToastAction(onRetry, () => notifySessionCheckFailed(onRetry))]
      : [],
    dedupeKey: "session-check-failed",
  });
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
