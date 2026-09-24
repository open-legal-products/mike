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

// Passive notification adapter. Recovery actions belong to separately reviewed flows.
import { describeError, type DescribeErrorOptions, type UserFacingError } from "@/shared/lib/userError";
import { showToast } from "@/shared/lib/toastStore";
import { isReported, reportError } from "@/app/lib/errorReporting";

export { describeError, UserVisibleError, isAbortError, isNetworkError } from "@/shared/lib/userError";

export interface NotifyErrorOptions extends DescribeErrorOptions {
    dedupeKey?: string;
}

export function notifyError(error: unknown, options: NotifyErrorOptions = {}): UserFacingError | null {
    const described = describeError(error, options);
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
