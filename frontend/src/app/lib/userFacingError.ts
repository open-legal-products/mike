import { MikeApiError, reportedUpstreamMessage } from "./mikeApi";

export function userFacingApiError(
    error: unknown,
    fallback: string,
): string {
    // The 5xx codes with something to say (a migration to apply, a server
    // to wait for) get their fixed frontend message (mikeApi.ts).
    if (error instanceof MikeApiError && error.code) {
        const upstream = reportedUpstreamMessage(error.code);
        if (upstream) return upstream;
    }
    if (
        error instanceof MikeApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.message
    ) {
        return error.message;
    }
    return fallback;
}

export function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return null;
    }
    return typeof error.code === "string" ? error.code : null;
}

export function knownErrorCodeMessage(
    error: unknown,
    messages: Readonly<Record<string, string>>,
    fallback: string,
): string {
    const code = errorCode(error);
    return code ? messages[code] ?? fallback : fallback;
}

// ---------------------------------------------------------------------------
// Notification layer
// ---------------------------------------------------------------------------
//
// `describeError` (shared) decides what to say; this file decides how the
// web app shows it: a toast with an honest "Retry" and, for failures the
// user cannot fix, a "Contact support" link that opens a pre-filled email.

import {
    UserVisibleError,
    buildSupportMailto,
    describeError as describeSharedError,
    type DescribeErrorOptions,
    type UserFacingError,
} from "@/shared/lib/userError";
import {
    createErrorNotifier,
    type NotifyErrorOptions,
} from "@/shared/lib/errorNotifier";
import { isReported, reportError } from "@/app/lib/errorReporting";

export {
    SUPPORT_EMAIL,
    UserVisibleError,
    isAbortError,
    isNetworkError,
    type UserErrorKind,
    type UserFacingError,
} from "@/shared/lib/userError";

export {
    notifyInfo,
    notifySuccess,
    type NotifyErrorOptions,
} from "@/shared/lib/errorNotifier";

/** The pre-filled support email for a described failure on this page. */
export function supportMailtoFor(
    error: UserFacingError,
    note?: string,
): string {
    return buildSupportMailto(error, {
        page: typeof window !== "undefined" ? window.location.href : undefined,
        product: "web",
        note,
    });
}

/** Screens that already are the way back in; "Sign in" would be a no-op. */
const AUTH_ROUTES = [
    "/login",
    "/signup",
    "/reset-password",
    "/forgot-password",
    "/verify-mfa",
    "/auth/callback",
    "/sso",
];

/**
 * Is the user looking at a sign-in screen? Those screens are the way back
 * in and render their own inline error, so session failures and "Sign in"
 * actions are not raised over them.
 */
export function isOnAuthRoute(): boolean {
    // No window (server render) reads as "/", which is not an auth route.
    const pathname = typeof window === "undefined" ? "" : window.location.pathname;
    const path = pathname.replace(/\/+$/, "") || "/";
    return AUTH_ROUTES.some(
        (route) => path === route || path.startsWith(`${route}/`),
    );
}

/**
 * Where "Sign in" goes, or null when the user is already on an auth screen
 * (and would be sent to the page they are looking at).
 */
function signInActionHref(): string | null {
    if (typeof window === "undefined" || isOnAuthRoute()) return null;
    const { pathname, search } = window.location;
    return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/**
 * Send real faults to Sentry, and only real faults.
 *
 * A 4xx is an intentional answer, a transport failure is already reported by
 * the API client under `component: mike-api`, and a cancellation is not a
 * failure at all. What is left is an unclassifiable throw (a bug in this
 * code) and a 5xx that reached a screen without going through the API
 * client. It runs BEFORE the shared notifier's console.warn so the console
 * bridge recognises the error as already sent and drops its own copy.
 */
function reportRealFault(
    error: unknown,
    described: UserFacingError,
    action: string | undefined,
): void {
    const isFault =
        !isReported(error) &&
        (described.kind === "unknown" || described.kind === "server");
    if (!isFault) return;
    reportError(error, { tags: { component: "notify", action } });
}

/**
 * Codes the server side already reported and phrased for users (mikeApi.ts:
 * schema_out_of_date, upstream_unavailable) keep that one sentence in a toast
 * too, so the error copy for them has a single source. A call site's own
 * `codeMessages` entry still wins.
 */
function withReportedUpstreamMessage<T extends DescribeErrorOptions>(error: unknown, options: T): T {
    // Duck-typed like describeError: the code is read off any error shape,
    // and mikeApi's table is consulted only when there is a code to look up.
    const raw = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    const code = typeof raw === "string" ? raw : null;
    const upstream = code ? reportedUpstreamMessage(code) : null;
    if (!code || !upstream) return options;
    return { ...options, codeMessages: { [code]: upstream, ...options.codeMessages } };
}

/**
 * The web app's `describeError`: the shared classifier plus mikeApi's fixed
 * sentences for server-reported 5xx codes. Web code imports it from here so
 * an inline message and a notice for the same failure read the same words;
 * calling the shared one directly drops those sentences.
 */
export function describeError(
    error: unknown,
    options: DescribeErrorOptions = {},
): UserFacingError {
    return describeSharedError(error, withReportedUpstreamMessage(error, options));
}

/**
 * Show a failure to the user. Returns the description so the caller can
 * also render it inline, or `null` when the failure is a cancellation the
 * user caused and does not need to hear about.
 *
 * The shared notifier (`@/shared/lib/errorNotifier`) owns the toast, the
 * Retry and the cancellation rule; the web app adds its upstream copy, its
 * Sentry reporting, "Sign in", and a `mailto:` support link.
 */
export const notifyError = createErrorNotifier<NotifyErrorOptions>({
    describeOptions: withReportedUpstreamMessage,
    beforeShow: (error, described, options) => {
        reportRealFault(error, described, options.action);
        return false;
    },
    present: (described, options, wantsSupport) => {
        // "Your session has expired" with nothing to click leaves the user to
        // find the way back to the login screen themselves.
        const signInHref = signInActionHref();
        return {
            actions:
                described.kind === "unauthenticated" && signInHref
                    ? [
                          {
                              label: "Sign in",
                              onClick: () => window.location.assign(signInHref),
                          },
                      ]
                    : [],
            supportHref: wantsSupport
                ? supportMailtoFor(described, options.supportNote)
                : undefined,
        };
    },
});

/**
 * Report a batch action (delete, move, upload) that failed for some items.
 *
 * `message` names what did not happen ("2 documents could not be moved:
 * a.pdf, b.pdf."). The items' own requests already went through the API
 * client, which reported any server fault, so this summary is classified as
 * a conflict: shown, retryable when `onRetry` re-runs only the items that
 * failed, and neither sent to Sentry again nor offered to support.
 */
export function notifyPartialFailure(
    message: string,
    options: Omit<NotifyErrorOptions, "support"> = {},
): UserFacingError | null {
    return notifyError(
        new UserVisibleError(message, {
            kind: "conflict",
            retryable: Boolean(options.onRetry),
        }),
        options,
    );
}
