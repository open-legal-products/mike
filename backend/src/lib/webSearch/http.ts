import { AppError } from "../appError";
import type { SearchApiDeps } from "./types";

const SEARCH_TIMEOUT_MS = 15_000;
// A read waits for the service to fetch the page itself.
export const READ_TIMEOUT_MS = 30_000;

/** The search API answered with an error status; `status` reaches Sentry as `dependency_status`. */
export class SearchApiError extends AppError {
    constructor(readonly status: number) {
        super("web_search.api_error", `The search API answered with HTTP ${status}`);
    }
}

export function withTimeout(
    signal: AbortSignal | undefined,
    ms: number,
): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchJson(
    url: string | URL,
    init: RequestInit,
    deps: SearchApiDeps,
    timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
    const response = await deps.fetch(url, {
        ...init,
        // Every request carries an API key, and fetch forwards custom headers
        // such as Brave's x-subscription-token across origins on a redirect.
        // No search API needs one, so a 3xx fails like any other status.
        redirect: "manual",
        signal: withTimeout(deps.signal, timeoutMs),
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SearchApiError(response.status);
    }
    return (await response.json()) as Record<string, unknown>;
}

export function postJson(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    deps: SearchApiDeps,
    timeoutMs?: number,
): Promise<Record<string, unknown>> {
    return fetchJson(
        url,
        {
            method: "POST",
            headers: {
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        },
        deps,
        timeoutMs,
    );
}
