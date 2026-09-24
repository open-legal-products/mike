/**
 * Turns any thrown value into something a person can act on.
 *
 * Every layer that can fail (fetch, the API client, Office.js, a stream)
 * throws its own shape. Screens should never guess at those shapes, and
 * they must never echo a raw `error.message` (stack text, provider names,
 * SQL) at a user. `describeError` is the single translation point: it
 * classifies the failure, picks a concise and accurate message, and says
 * whether a retry or a support hand-off makes sense.
 *
 * This module is shared by the web app and the Word add-in, so it must stay
 * framework-free and must not import from `frontend/src/app/`.
 */

export const SUPPORT_EMAIL = "will@mikeoss.com";

export type UserErrorKind =
    | "offline"
    | "network"
    | "timeout"
    | "aborted"
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "validation"
    | "payload_too_large"
    | "rate_limited"
    | "unavailable"
    | "server"
    | "unknown";

export interface UserFacingError {
    kind: UserErrorKind;
    /** Short headline, e.g. "Couldn't save the document". */
    title: string;
    /** One or two concise sentences that say what happened and what to do. */
    message: string;
    /** Whether offering "Retry" is honest for this failure. */
    retryable: boolean;
    /** Whether "Contact support" should be offered. */
    supportable: boolean;
    status: number | null;
    code: string | null;
    requestId: string | null;
    /** The original thrown value, for logging. Never render this. */
    cause: unknown;
}

export interface DescribeErrorOptions {
    /**
     * What the user was trying to do, in the imperative and lower case, e.g.
     * "save the document". Produces the title "Couldn't save the document".
     */
    action?: string;
    /** Message for failures this module cannot classify. */
    fallback?: string;
    /** Per-call-site overrides keyed by backend `code`. */
    codeMessages?: Readonly<Record<string, string>>;
}

/**
 * Throw this (or any object with `userVisible: true`) when the message is
 * written for the user and safe to display verbatim.
 */
export class UserVisibleError extends Error {
    readonly userVisible = true;
    readonly kind: UserErrorKind;
    readonly retryable: boolean;

    constructor(
        message: string,
        options: { kind?: UserErrorKind; retryable?: boolean; cause?: unknown } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "UserVisibleError";
        this.kind = options.kind ?? "unknown";
        this.retryable = options.retryable ?? false;
    }
}

export const GENERIC_FAILURE_MESSAGE =
    "Something went wrong. Try again, and contact support if it keeps happening.";

const KIND_TITLES: Record<UserErrorKind, string> = {
    offline: "You're offline",
    network: "Connection problem",
    timeout: "Request timed out",
    aborted: "Cancelled",
    unauthenticated: "Sign in required",
    forbidden: "Permission denied",
    not_found: "Not found",
    conflict: "Conflict",
    validation: "Check your input",
    payload_too_large: "Too large",
    rate_limited: "Slow down",
    unavailable: "Service unavailable",
    server: "Something went wrong",
    unknown: "Something went wrong",
};

/**
 * The one sentence shown when a request never reached the server.
 *
 * Both clients say this. The add-in passes the origin because Mike is
 * self-hostable and "check your connection" is useless advice to someone
 * whose own API container is down; the web app omits it because the API is
 * same-origin there and naming it would add noise, not information.
 */
export function networkMessage(origin?: string): string {
    // Naming the origin is for self-hosters, whose own server may be the
    // thing that is down, so that variant also says to check the server.
    if (origin) {
        return `Mike couldn't reach the server at ${origin}. Check your connection and that the server is running, then try again.`;
    }
    return "Mike couldn't reach the server. Check your connection and try again.";
}

const KIND_MESSAGES: Record<UserErrorKind, string> = {
    offline: "Your device is offline. Check your connection and try again.",
    network: networkMessage(),
    timeout: "The server took too long to respond. Try again.",
    aborted: "The request was cancelled.",
    unauthenticated: "Your session has expired. Sign in again to continue.",
    forbidden: "You don't have permission to do this.",
    not_found: "That item no longer exists or was moved.",
    conflict: "This was changed somewhere else. Refresh and try again.",
    validation: "Some of the information provided isn't valid.",
    payload_too_large: "That's too large to upload.",
    rate_limited: "Too many requests. Wait a moment and try again.",
    unavailable:
        "Mike is temporarily unavailable. Try again in a moment.",
    server: "Something went wrong on our side. Try again.",
    unknown: GENERIC_FAILURE_MESSAGE,
};

const RETRYABLE: ReadonlySet<UserErrorKind> = new Set([
    "offline",
    "network",
    "timeout",
    "conflict",
    "rate_limited",
    "unavailable",
    "server",
    "unknown",
]);

const SUPPORTABLE: ReadonlySet<UserErrorKind> = new Set([
    "forbidden",
    "unavailable",
    "server",
    "unknown",
]);

/**
 * Backend `code` values whose meaning is stable across routes.
 *
 * Every entry must be a code some server actually emits — the API
 * (`backend/src`) or the Next proxy route (`frontend/src/app/api`). An
 * invented code is worse than no entry: it looks like coverage while the
 * real failure falls through to the status-based classification below.
 */
export const CODE_KINDS: Readonly<Record<string, UserErrorKind>> = {
    // Throttling
    rate_limited: "rate_limited",
    upload_session_control_rate_limit: "rate_limited",
    upload_session_poll_rate_limit: "rate_limited",
    upload_session_rate_limit_exceeded: "rate_limited",
    // Size limits
    request_too_large: "payload_too_large",
    upload_file_too_large: "payload_too_large",
    upload_batch_too_large: "payload_too_large",
    // Input the user can correct
    validation_failed: "validation",
    invalid_request: "validation",
    invalid_json: "validation",
    password_too_short: "validation",
    password_too_long: "validation",
    email_address_invalid: "validation",
    upload_incomplete: "validation",
    missing_api_key: "validation",
    model_unavailable: "validation",
    model_required: "validation",
    // Identity
    authentication_failed: "unauthenticated",
    session_expired: "unauthenticated",
    cookie_session_required: "unauthenticated",
    mfa_verification_required: "forbidden",
    untrusted_origin: "forbidden",
    // Something else changed first
    review_running: "conflict",
    review_stale: "conflict",
    memory_revision_conflict: "conflict",
    upload_target_busy: "conflict",
    access_inherited: "conflict",
    ask_inputs_stale: "conflict",
    // Ours, not theirs
    internal_error: "server",
    upstream_unavailable: "unavailable",
};

type ErrorLike = {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    requestId?: unknown;
    request_id?: unknown;
    userVisible?: unknown;
    kind?: unknown;
    retryable?: unknown;
};

function asErrorLike(error: unknown): ErrorLike | null {
    return error !== null && typeof error === "object"
        ? (error as ErrorLike)
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

function readStatus(error: ErrorLike | null): number | null {
    const raw = error?.status ?? error?.statusCode;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 100
        ? raw
        : null;
}

export function isOffline(): boolean {
    return (
        typeof navigator !== "undefined" &&
        typeof navigator.onLine === "boolean" &&
        navigator.onLine === false
    );
}

const NETWORK_MESSAGE_PATTERN =
    /failed to fetch|fetch failed|networkerror|network request failed|load failed|network error|ERR_NETWORK|ECONNREFUSED|ECONNRESET|ENOTFOUND/i;

export function isNetworkError(error: unknown): boolean {
    const like = asErrorLike(error);
    if (!like) return false;
    if (like.name === "NetworkError") return true;
    const message = readString(like.message) ?? "";
    return error instanceof TypeError
        ? NETWORK_MESSAGE_PATTERN.test(message)
        : /^(ERR_NETWORK|ECONNREFUSED|ECONNRESET|ENOTFOUND)$/.test(
              readString(like.code) ?? "",
          );
}

export function isAbortError(error: unknown): boolean {
    const like = asErrorLike(error);
    return like?.name === "AbortError";
}

export function isTimeoutError(error: unknown): boolean {
    const like = asErrorLike(error);
    return like?.name === "TimeoutError" || like?.code === "ETIMEDOUT";
}

function kindForStatus(status: number): UserErrorKind {
    if (status === 401) return "unauthenticated";
    if (status === 403) return "forbidden";
    if (status === 404 || status === 410) return "not_found";
    if (status === 409) return "conflict";
    if (status === 413) return "payload_too_large";
    if (status === 429) return "rate_limited";
    if (status === 408 || status === 504) return "timeout";
    if (status === 502 || status === 503) return "unavailable";
    if (status >= 500) return "server";
    if (status === 400 || status === 422 || status === 415) return "validation";
    if (status >= 400) return "validation";
    return "unknown";
}

function titleFor(kind: UserErrorKind, action?: string): string {
    if (action) {
        const trimmed = action.trim().replace(/[.!]+$/, "");
        if (trimmed) return `Couldn't ${trimmed}`;
    }
    return KIND_TITLES[kind];
}

/**
 * Classify a thrown value and produce the text the user should see.
 *
 * Message precedence, highest first:
 * 1. `codeMessages[code]` supplied by the call site.
 * 2. A `UserVisibleError` (or `userVisible: true`) message, verbatim.
 * 3. The API's own 4xx `detail`, which the backend writes for users.
 * 4. The generic message for the classified kind.
 * 5. `fallback`, for anything unclassifiable.
 */
export function describeError(
    error: unknown,
    options: DescribeErrorOptions = {},
): UserFacingError {
    const like = asErrorLike(error);
    const status = readStatus(like);
    const code = readString(like?.code);
    const requestId =
        readString(like?.requestId) ?? readString(like?.request_id) ?? null;
    const apiMessage = readString(like?.message);

    let kind: UserErrorKind;
    let message: string | null = null;

    if (isAbortError(error)) {
        kind = "aborted";
    } else if (isTimeoutError(error)) {
        kind = "timeout";
    } else if (isOffline() && (status === null || isNetworkError(error))) {
        kind = "offline";
    } else if (isNetworkError(error)) {
        kind = "network";
    } else if (like?.userVisible === true && apiMessage) {
        kind =
            typeof like.kind === "string" && like.kind in KIND_TITLES
                ? (like.kind as UserErrorKind)
                : "unknown";
        message = apiMessage;
    } else if (status !== null) {
        kind = (code && CODE_KINDS[code]) || kindForStatus(status);
        // 4xx bodies are written for users by the backend; 5xx bodies never
        // are, and the API client already replaced them with a safe line.
        if (status < 500 && apiMessage && !/^API error: \d+$/.test(apiMessage)) {
            message = apiMessage;
        }
    } else if (code && CODE_KINDS[code]) {
        kind = CODE_KINDS[code];
    } else {
        kind = "unknown";
    }

    if (code && options.codeMessages && options.codeMessages[code]) {
        message = options.codeMessages[code];
    }

    if (!message) {
        message =
            kind === "unknown" && options.fallback
                ? options.fallback
                : KIND_MESSAGES[kind];
    }

    let retryable = RETRYABLE.has(kind);
    if (like?.userVisible === true && typeof like.retryable === "boolean") {
        retryable = like.retryable;
    }

    return {
        kind,
        title: titleFor(kind, options.action),
        message,
        retryable,
        supportable: SUPPORTABLE.has(kind),
        status,
        code,
        requestId,
        cause: error,
    };
}

/** Only a route belongs in diagnostics; URLs may carry auth tokens or user input. */
export function supportPageContext(page: string): string {
    try {
        const url = new URL(page);
        return `${url.origin}${url.pathname}`;
    } catch {
        return page.split(/[?#]/, 1)[0] ?? "";
    }
}

export interface SupportMailtoContext {
    /** Where it happened: a page URL or a screen name. */
    page?: string;
    when?: Date;
    /** Which client the user is in. */
    product?: string;
    /** Free text the caller wants included, e.g. the action attempted. */
    note?: string;
}

/**
 * Build a `mailto:` link to support that carries everything needed to
 * find the failure in the logs. Fields are omitted when unknown so the
 * draft never contains "null".
 */
export function buildSupportMailto(
    error: Pick<
        UserFacingError,
        "title" | "message" | "kind" | "status" | "code" | "requestId"
    >,
    context: SupportMailtoContext = {},
): string {
    const when = context.when ?? new Date();
    const lines: string[] = [
        "Hi Mike team,",
        "",
        "I ran into a problem and need help.",
        "",
        `What happened: ${error.title}`,
        `Message shown: ${error.message}`,
    ];
    if (context.note) lines.push(`Details: ${context.note}`);
    lines.push("");
    lines.push("--- Details for support (please keep) ---");
    if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
    if (error.code) lines.push(`Error code: ${error.code}`);
    if (error.status !== null) lines.push(`HTTP status: ${error.status}`);
    lines.push(`Category: ${error.kind}`);
    if (context.page) lines.push(`Page: ${supportPageContext(context.page)}`);
    if (context.product) lines.push(`Client: ${context.product}`);
    lines.push(`Time: ${when.toISOString()}`);
    if (typeof navigator !== "undefined" && navigator.userAgent) {
        lines.push(`Browser: ${navigator.userAgent}`);
    }
    lines.push("", "Thanks,");

    const subject = `Mike support: ${error.title}`;
    const params = new URLSearchParams({
        subject,
        body: lines.join("\n"),
    });
    // URLSearchParams encodes spaces as "+", which mail clients render
    // literally. Percent-encode them so the draft reads as typed.
    return `mailto:${SUPPORT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}
