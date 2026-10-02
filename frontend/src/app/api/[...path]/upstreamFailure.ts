import { diagnosticErrorTags } from "@/shared/lib/sentryPrivacy";

/**
 * Connection-level failures: the Next server could not reach the backend at
 * all (stopped, restarting, wrong host, network down). Node's fetch reports
 * every one of them as the same `TypeError: fetch failed`; the real code sits
 * on its `cause`, or on each entry of an AggregateError when several
 * addresses were tried. A response that arrived late (UND_ERR_HEADERS_TIMEOUT)
 * is deliberately not here: that backend is up, only slow.
 */
const UNREACHABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);

/** The pinned Sentry fingerprint shared by every unreachable-backend report. */
export const UPSTREAM_UNAVAILABLE_FINGERPRINT = "upstream-unavailable";

/**
 * The connection-level code behind an upstream fetch failure, or null when
 * the failure is anything else. Walks `cause` and AggregateError `errors`
 * through the same bounded, allowlisted walk the Sentry boundary uses, so
 * no message text is ever read into the result.
 */
export function upstreamUnreachableCode(error: unknown): string | null {
    const code = diagnosticErrorTags(error).failure_code;
    return typeof code === "string" && UNREACHABLE_CODES.has(code) ? code : null;
}

/**
 * At most one report per key per window. A stopped backend fails every
 * request the browser makes (a page load is a dozen), and each one is the
 * same fact; one warning a minute per cause is enough to say it is still
 * happening. Suppressed requests are still logged locally.
 */
export function createReportWindow(options?: {
    windowMs?: number;
    now?: () => number;
}) {
    const windowMs = options?.windowMs ?? 60_000;
    const now = options?.now ?? (() => Date.now());
    const lastReported = new Map<string, number>();
    return {
        allow(key: string): boolean {
            const at = now();
            const previous = lastReported.get(key);
            if (previous !== undefined && at - previous < windowMs) return false;
            lastReported.set(key, at);
            return true;
        },
        reset(): void {
            lastReported.clear();
        },
    };
}

/** Process-wide: one Next server, one budget for "the backend is down". */
export const upstreamReportWindow = createReportWindow();
