import { MikeApiError } from "./mikeApi";

export function userFacingApiError(
    error: unknown,
    fallback: string,
): string {
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
    buildSupportMailto,
    describeError,
    type DescribeErrorOptions,
    type UserFacingError,
} from "@/shared/lib/userError";
import { showToast, type ToastAction } from "@/shared/lib/toastStore";
import { isReported, reportError } from "@/app/lib/errorReporting";

export {
    SUPPORT_EMAIL,
    UserVisibleError,
    describeError,
    isAbortError,
    isNetworkError,
    type UserErrorKind,
    type UserFacingError,
} from "@/shared/lib/userError";

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
}

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
 * Where "Sign in" goes, or null when the user is already on an auth screen
 * (and would be sent to the page they are looking at).
 */
function signInActionHref(): string | null {
    if (typeof window === "undefined") return null;
    const { pathname, search } = window.location;
    const path = pathname.replace(/\/+$/, "") || "/";
    if (
        AUTH_ROUTES.some(
            (route) => path === route || path.startsWith(`${route}/`),
        )
    ) {
        return null;
    }
    return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/**
 * Send real faults to Sentry, and only real faults.
 *
 * A 4xx is an intentional answer, a transport failure is already reported by
 * the API client under `component: mike-api`, and a cancellation is not a
 * failure at all. What is left is an unclassifiable throw (a bug in this
 * code) and a 5xx that reached a screen without going through the API
 * client. This runs BEFORE the console.warn below so the console bridge
 * recognises the error as already sent and drops its own copy.
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

    reportRealFault(error, described, options.action);

    // warn, not error: Sentry's console bridge forwards console.error, and
    // a 4xx or a cancellation the user just saw is not an incident. The one
    // above already reported anything that was a real fault.
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
    // "Your session has expired" with nothing to click leaves the user to
    // find the way back to the login screen themselves.
    const signInHref = signInActionHref();
    if (described.kind === "unauthenticated" && signInHref) {
        actions.push({
            label: "Sign in",
            onClick: () => window.location.assign(signInHref),
        });
    }
    const wantsSupport = options.support ?? described.supportable;

    showToast({
        tone: "error",
        title: described.title,
        message: described.message,
        actions,
        supportHref: wantsSupport
            ? supportMailtoFor(described, options.supportNote)
            : undefined,
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
