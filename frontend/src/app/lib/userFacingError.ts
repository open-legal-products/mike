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
