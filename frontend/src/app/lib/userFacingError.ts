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

// Passive notification adapter. Recovery actions belong to separately reviewed flows.
import { describeError, type DescribeErrorOptions, type UserFacingError } from "@/shared/lib/userError";
import { showToast } from "@/shared/lib/toastStore";
import { isReported, reportError } from "@/app/lib/errorReporting";

export { describeError, UserVisibleError, isAbortError, isNetworkError } from "@/shared/lib/userError";

export interface NotifyErrorOptions extends DescribeErrorOptions {
    dedupeKey?: string;
}

/**
 * Codes the server side already reported and phrased for users (mikeApi.ts:
 * schema_out_of_date, upstream_unavailable) keep that one sentence in a toast
 * too, so the error copy for them has a single source. A call site's own
 * `codeMessages` entry still wins.
 */
function withReportedUpstreamMessage(error: unknown, options: NotifyErrorOptions): NotifyErrorOptions {
    // Duck-typed like describeError: the code is read off any error shape,
    // and mikeApi's table is consulted only when there is a code to look up.
    const raw = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    const code = typeof raw === "string" ? raw : null;
    const upstream = code ? reportedUpstreamMessage(code) : null;
    if (!code || !upstream) return options;
    return { ...options, codeMessages: { [code]: upstream, ...options.codeMessages } };
}

export function notifyError(error: unknown, options: NotifyErrorOptions = {}): UserFacingError | null {
    const described = describeError(error, withReportedUpstreamMessage(error, options));
    if (described.kind === "aborted") return null;
    if (!isReported(error) && (described.kind === "unknown" || described.kind === "server")) {
        reportError(error, { tags: { component: "notify", action: options.action } });
    }
    showToast({ tone: "error", title: described.title, message: described.message, dedupeKey: options.dedupeKey });
    return described;
}

export function notifySuccess(message: string, title?: string): string {
    return showToast({ tone: "success", title, message });
}

export function notifyInfo(message: string, title?: string): string {
    return showToast({ tone: "info", title, message });
}
