/**
 * Error reporting for the web app: a thin, testable layer over the Sentry
 * SDK. Application code calls these helpers instead of `@sentry/nextjs`
 * directly so the PII policy (see `@/shared/lib/sentryEvent`) and the
 * explicit opt-out rule live in one place.
 */

import * as Sentry from "@sentry/nextjs";
import { privacyBoundaryIntegration } from "@/shared/lib/sentryPrivacy";
import {
    MIKE_SENTRY_DSN,
    createEventScrubber,
    installKind,
    normalizeApiPath,
    parseSampleRate,
    releaseName,
    resolveDsn,
} from "@/shared/lib/sentryEvent";

export type ReportLevel = "fatal" | "error" | "warning";

export type ReportContext = {
    tags?: Record<string, string | number | boolean | null | undefined>;
    extra?: Record<string, unknown>;
    level?: ReportLevel;
    fingerprint?: string[];
};

// NEXT_PUBLIC_* is inlined into the browser bundle at build time; the Next
// server reads SENTRY_INSTALL at runtime. Anything but "official" is a
// community install and gets the minimised event shape.
const install = installKind(
    process.env.NEXT_PUBLIC_SENTRY_INSTALL ?? process.env.SENTRY_INSTALL,
);
const scrubber = createEventScrubber({ install });

/** `beforeSend` for every Sentry client in the web app (browser, server, edge). */
export const scrubEvent = scrubber.scrubEvent;

/**
 * The scrubber's "already sent" registry is a closure, so it can answer the
 * console bridge but not a caller. This mirror answers callers: a screen
 * that catches an error the API client already reported (every 5xx, every
 * transport failure) must not report it a second time under its own tags.
 */
const reportedHere = new WeakSet<object>();

function markReported(error: unknown): void {
    scrubber.markReported(error);
    if (error && typeof error === "object") reportedHere.add(error);
}

/** Has this exact error object already been sent to Sentry with context? */
export function isReported(error: unknown): boolean {
    return (
        error !== null && typeof error === "object" && reportedHere.has(error)
    );
}

function applyContext(scope: Sentry.Scope, context: ReportContext): void {
    if (context.level) scope.setLevel(context.level);
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
        if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
        scope.setExtra(key, value);
    }
}

/**
 * Report an error with structured context. Call it BEFORE any accompanying
 * console.error so the console bridge recognises the error as already sent.
 */
export function reportError(
    error: unknown,
    context: ReportContext = {},
): string | null {
    markReported(error);
    if (!Sentry.isEnabled()) return null;
    return Sentry.withScope((scope) => {
        applyContext(scope, context);
        return Sentry.captureException(error);
    });
}

/**
 * A backend 5xx seen from the browser. The request id is the same one the
 * backend attached to its own event, so the two sides of one failure can be
 * matched in Sentry by searching `request_id:<id>`.
 */
export function reportApiFailure(failure: {
    path: string;
    status: number;
    code?: string | null;
    requestId?: string | null;
    method?: string;
    /**
     * The error object the caller is about to throw. Marking it here means
     * the `console.error(..., error)` a screen logs when it catches it is
     * recognised by the console bridge as this same failure and not sent
     * again.
     */
    error?: unknown;
}): string | null {
    markReported(failure.error);
    if (!Sentry.isEnabled()) return null;
    const route = normalizeApiPath(failure.path);
    const method = failure.method ?? "GET";
    return Sentry.withScope((scope) => {
        applyContext(scope, {
            level: "error",
            tags: {
                component: "mike-api",
                http_status: failure.status,
                http_method: method,
                http_route: route,
                request_id: failure.requestId,
                error_code: failure.code,
                ...(route === "/observability/sentry-test" ? { diagnostic_test: "true" } : {}),
            },
            extra: { path: failure.path },
            fingerprint: ["api-5xx", method, route, String(failure.status)],
        });
        return Sentry.captureMessage(
            `API ${failure.status} on ${method} ${route}`,
            "error",
        );
    });
}

/**
 * When the page started to go away (reload, link to another document, tab
 * close), or null while it is live. A browser rejects every fetch still in
 * flight at that moment with the same bare "Failed to fetch" TypeError an
 * unreachable server produces, and no AbortSignal is involved, so the
 * request layer cannot tell the two apart from the error itself.
 */
let pageLeavingSince: number | null = null;
/**
 * `beforeunload` fires when a navigation starts but can be cancelled by a
 * "leave site?" prompt (the memory editor installs one); after this long
 * the page is treated as live again. `pagehide` is final until `pageshow`.
 */
const BEFOREUNLOAD_GRACE_MS = 3_000;
const hasWindow = () =>
    typeof window !== "undefined" && typeof window.addEventListener === "function";
if (hasWindow()) {
    window.addEventListener("pagehide", () => {
        pageLeavingSince = Number.POSITIVE_INFINITY;
    });
    window.addEventListener("pageshow", () => {
        pageLeavingSince = null;
    });
}

const onBeforeUnload = () => {
    pageLeavingSince = Date.now();
};
let pendingRequests = 0;
/**
 * Count a request as in flight until the returned release is called. The
 * `beforeunload` listener exists only while something is pending: Firefox
 * refuses to put a page with a `beforeunload` listener into its back/forward
 * cache, so keeping one installed on every page would make every back and
 * forward navigation rebuild the app. A page with no request in flight has
 * nothing this listener could protect.
 */
export function trackPendingRequest(): () => void {
    let released = false;
    if (pendingRequests === 0 && hasWindow()) {
        window.addEventListener("beforeunload", onBeforeUnload);
    }
    pendingRequests += 1;
    return () => {
        if (released) return;
        released = true;
        pendingRequests -= 1;
        if (pendingRequests === 0 && hasWindow()) {
            window.removeEventListener("beforeunload", onBeforeUnload);
        }
    };
}

function pageIsBeingLeft(): boolean {
    if (pageLeavingSince === null) return false;
    if (pageLeavingSince === Number.POSITIVE_INFINITY) return true;
    return Date.now() - pageLeavingSince < BEFOREUNLOAD_GRACE_MS;
}

/**
 * Fetch failed without an HTTP response. Browser errors alone cannot tell
 * whether the request reached the server, or distinguish TLS, CORS, a dropped
 * connection, and a failed response read. It was previously reported only
 * through the console bridge as one undifferentiated "Failed to fetch"
 * issue with no endpoint. Warning level, grouped per endpoint.
 *
 * Not reported while the page is being left: those are cancellations of the
 * old page's requests, not failures anyone can act on. The error is still
 * marked so a screen's later console.error of it is not bridged either.
 */
export function reportNetworkFailure(
    error: unknown,
    request: { method: string; url: string },
): string | null {
    markReported(error);
    if (!Sentry.isEnabled() || pageIsBeingLeft()) return null;
    const route = normalizeApiPath(request.url);
    let networkState = "unknown";
    let requestOrigin = "unknown";
    try {
        if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
            networkState = navigator.onLine ? "online" : "offline";
        }
        if (typeof window !== "undefined") {
            requestOrigin = new URL(request.url, window.location.href).origin === window.location.origin
                ? "same-origin" : "cross-origin";
        }
    } catch {
        // Missing browser state or malformed URLs must not break reporting.
    }
    return Sentry.withScope((scope) => {
        applyContext(scope, {
            level: "warning",
            tags: {
                component: "mike-api",
                network: true,
                network_state: networkState,
                request_origin: requestOrigin,
                http_method: request.method,
                http_route: route,
            },
            extra: { url: route },
            fingerprint: ["api-network", request.method, route],
        });
        return Sentry.captureException(error);
    });
}

/** Attach (or clear) the signed-in user's id — never the email. */
export function setReportingUser(user: { id: string } | null): void {
    if (!Sentry.isEnabled()) return;
    Sentry.setUser(user ? { id: user.id } : null);
}

/**
 * Browser SDK options. `NEXT_PUBLIC_*` values are inlined at build time, so
 * the caller (instrumentation-client.ts) reads them literally and passes
 * them in; everything policy-shaped is decided here.
 */
export function browserSentryOptions(env: {
    disabled?: string;
    dsn?: string;
    install?: string;
    environment?: string;
    release?: string;
    gitSha?: string;
    tracesSampleRate?: string;
    nodeEnv?: string;
}): Sentry.BrowserOptions {
    // ON BY DEFAULT: the Mike project's own DSN unless NEXT_PUBLIC_SENTRY_DISABLED
    // or a DSN of your own is baked in at build time (README, "Telemetry").
    const { dsn } = resolveDsn({
        disabled: env.disabled,
        dsn: env.dsn,
        fallback: MIKE_SENTRY_DSN.frontend,
    });
    return {
        dsn: dsn || undefined,
        enabled: dsn.length > 0,
        environment: env.environment?.trim() || "self-hosted",
        release: releaseName(env.release, env.gitSha),
        tracesSampleRate: parseSampleRate(env.tracesSampleRate, 0),
        // Session replay is deliberately NOT enabled: it would record
        // privileged document text on screen.
        sendDefaultPii: false,
        attachStacktrace: true,
        integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
        initialScope: {
            tags: {
                service: "mike-frontend",
                runtime: "browser",
                build_mode: env.nodeEnv,
                diagnostics_version: "2",
                install: installKind(env.install),
            },
        },
        beforeSend: scrubEvent,
    };
}

/** Server / edge SDK options; env is read at runtime on the Next server. */
export function serverSentryOptions(
    runtime: "server" | "edge",
    env: NodeJS.ProcessEnv,
): Sentry.NodeOptions {
    const { dsn } = resolveDsn({
        disabled: env.SENTRY_DISABLED,
        dsn: env.SENTRY_DSN,
        fallback: MIKE_SENTRY_DSN.frontend,
    });
    return {
        dsn: dsn || undefined,
        enabled: dsn.length > 0,
        environment: env.SENTRY_ENVIRONMENT?.trim() || "self-hosted",
        integrations: [privacyBoundaryIntegration()],
        release: releaseName(env.SENTRY_RELEASE, env.GIT_SHA),
        tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
        sendDefaultPii: false,
        attachStacktrace: true,
        initialScope: {
            tags: {
                service: "mike-frontend",
                runtime,
                build_mode: env.NODE_ENV,
                diagnostics_version: "2",
                install: installKind(env.SENTRY_INSTALL),
            },
        },
        beforeSend: scrubEvent,
    };
}
