import {
    MikeApiError,
    UploadBatchError,
    reportedUpstreamMessage,
    type UploadOutcome,
} from "./mikeApi";
import type { Operation } from "@/shared/lib/sentryPrivacy";

export type { Operation };

/**
 * Names the user-level flow a failure belongs to. Every reporting helper in
 * this file accepts it; when it is set, a server or unknown fault is sent to
 * Sentry tagged with it, so the event is titled "Failure in <operation> /
 * …". Default stack grouping still distinguishes failure sites. Use a static
 * developer-authored label; no registration is required. Never derive a label
 * from user input or a dependency response.
 */
export interface FaultIdentity {
    operation?: Operation;
}

export function userFacingApiError(
    error: unknown,
    fallback: string,
    identity: FaultIdentity = {},
): string {
    if (identity.operation) reportFault(error, identity);
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
    type NotifyErrorOptions as SharedNotifyErrorOptions,
} from "@/shared/lib/errorNotifier";
import { isReported, reportError, claimApiFailure } from "@/app/lib/errorReporting";

export {
    SUPPORT_EMAIL,
    UserVisibleError,
    isAbortError,
    isNetworkError,
    type UserErrorKind,
    type UserFacingError,
} from "@/shared/lib/userError";

export { notifyInfo, notifySuccess } from "@/shared/lib/errorNotifier";

/** The shared toast options plus the web app's Sentry identity. */
export interface NotifyErrorOptions
    extends SharedNotifyErrorOptions,
        FaultIdentity {}

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
    operation: Operation | undefined,
): void {
    // An API 5xx the client reported is still holding its event for this
    // screen's operation name; with one, that event goes out carrying it.
    if (operation && claimApiFailure(error, operation)) return;
    const isFault =
        !isReported(error) &&
        (described.kind === "unknown" || described.kind === "server");
    if (!isFault) return;
    // The server's own code and request id are what let this event be
    // matched to the backend's half of the failure; `action` is free text
    // for the toast and is dropped at the privacy boundary.
    const shaped = error && typeof error === "object" ? (error as { code?: unknown; requestId?: unknown; request_id?: unknown }) : null;
    const code = typeof shaped?.code === "string" ? shaped.code : undefined;
    const requestId = typeof shaped?.requestId === "string" ? shaped.requestId : typeof shaped?.request_id === "string" ? shaped.request_id : undefined;
    // A stream error frame (server kind, a request id, no HTTP status) is a
    // failure the backend already reported with its stack; the toast is for
    // the user, not a second report. An HTTP 5xx keeps both halves.
    const status = typeof (shaped as { status?: unknown } | null)?.status === "number" ? (shaped as { status: number }).status : undefined;
    if (described.kind === "server" && requestId && status === undefined) return;
    reportError(error, { tags: { component: "notify", action, error_code: code, request_id: requestId, operation } });
}

/**
 * Report a failure a screen shows inline (or swallows) without a toast, under
 * the flow it belongs to. Same rule as the toast: only a server or unknown
 * fault that nothing has reported yet is sent; 4xx answers, cancellations and
 * transport failures (reported by the API client) are not. Returns the
 * description so a caller can render it in the same breath.
 */
export function reportFault(
    error: unknown,
    options: DescribeErrorOptions & FaultIdentity,
): UserFacingError {
    const { operation, ...describeOptions } = options;
    const described = describeError(error, describeOptions);
    reportRealFault(error, described, describeOptions.action, operation);
    return described;
}

/**
 * A failure that did not arrive as a thrown error: a non-ok response a
 * stream caller read by hand, or an `error` frame on an SSE stream. The
 * response's status, code and request id are the tags that match it to the
 * backend's own event. A 4xx is an intentional refusal and is not reported;
 * a code the vocabulary does not list is dropped at the privacy boundary.
 * When `error` is the object the caller is about to throw, it is marked so
 * the toast that catches it does not file the same failure twice.
 */
export function reportFlowFailure(args: {
    operation: Operation;
    /** Which client layer saw it; the API client unless the caller says. */
    component?: "mike-api" | "assistant-chat";
    status?: number | null;
    code?: string | null;
    requestId?: string | null;
    method?: string;
    /** The request path, reduced to a route at the boundary. Never a document name. */
    path?: string;
    error?: unknown;
    level?: "error" | "warning";
}): void {
    const status = typeof args.status === "number" ? args.status : undefined;
    if (status !== undefined && status < 500) return;
    if (args.error !== undefined && isReported(args.error)) return;
    // A stream error frame (no HTTP status: the request itself succeeded)
    // that carries the server's request id is a failure the backend already
    // reported with the real stack; a second, stackless event from the
    // browser would only split the issue. An HTTP 5xx keeps both halves,
    // joined by the request id, as the API client does.
    if (args.error === undefined && status === undefined && args.requestId) return;
    reportError(
        args.error ?? new Error(`Failure in ${args.operation}`),
        {
            level: args.level,
            tags: {
                component: args.component ?? "mike-api",
                operation: args.operation,
                http_status: status,
                http_method: args.method,
                http_route: args.path,
                error_code: args.code ?? undefined,
                request_id: args.requestId ?? undefined,
            },
        },
    );
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
 *
 * With an `operation`, a described server or unknown fault is also reported
 * under that flow (see `reportFault`), so an inline error message is never
 * the only trace a failure leaves.
 */
export function describeError(
    error: unknown,
    options: DescribeErrorOptions & FaultIdentity = {},
): UserFacingError {
    const { operation, ...describeOptions } = options;
    const described = describeSharedError(
        error,
        withReportedUpstreamMessage(error, describeOptions),
    );
    if (operation) {
        reportRealFault(error, described, describeOptions.action, operation);
    }
    return described;
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
        reportRealFault(error, described, options.action, options.operation);
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
 *
 * When the batch has an underlying failure the API client did not see (an
 * outcome the upload client synthesised, a throw from a local phase), pass
 * it as `cause` with the `operation` it belongs to: it is reported under
 * that flow when it is a server or unknown fault, and stays quiet when it is
 * a user-side conflict, validation refusal or cancellation.
 */
export function notifyPartialFailure(
    message: string,
    options: Omit<NotifyErrorOptions, "support"> & { cause?: unknown } = {},
): UserFacingError | null {
    const { cause, operation, ...rest } = options;
    if (operation && cause !== undefined) {
        reportFault(cause, { action: rest.action, operation });
    }
    return notifyError(
        new UserVisibleError(message, {
            kind: "conflict",
            retryable: Boolean(rest.onRetry),
        }),
        rest,
    );
}

/**
 * Upload outcome codes the user caused or can fix themselves (limits, a
 * document changed under them), or that were already reported when they
 * happened (a storage PUT, reported per part by the API client). A batch
 * whose failures are all of these has nothing left to report.
 */
const USER_SIDE_UPLOAD_CODES: ReadonlySet<string> = new Set([
    "too_many_files",
    "upload_file_too_large",
    "upload_batch_too_large",
    "document_changed",
    "upload_target_busy",
    "direct_upload_failed",
]);

/**
 * The `cause` for `notifyPartialFailure` after an upload batch: an
 * `UploadBatchError` over the outcomes when at least one failure is ours
 * (processing failed or timed out, a confirmation the server never gave), or
 * null when every failure is user-side or already reported. The error carries
 * the outcomes, never a message a user sees; its filenames stay out of the
 * event because the boundary keeps only vocabulary tags.
 */
export function uploadBatchFault(
    outcomes: ReadonlyArray<UploadOutcome>,
): UploadBatchError | null {
    const failures = outcomes.filter((outcome) => outcome.status === "error");
    const ours = failures.some(
        (outcome) => !USER_SIDE_UPLOAD_CODES.has(outcome.errorCode ?? ""),
    );
    if (!ours) return null;
    return new UploadBatchError("Some documents could not be uploaded.", [
        ...failures,
    ]);
}
