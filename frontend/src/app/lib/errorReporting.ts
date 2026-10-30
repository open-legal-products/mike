/**
 * Error reporting for the web app: a thin, testable layer over the Sentry
 * SDK. Application code calls these helpers instead of `@sentry/nextjs`
 * directly so the PII policy (see `@/shared/lib/sentryEvent`) and the
 * explicit opt-out rule live in one place.
 */

import * as Sentry from "@sentry/nextjs";
import { privacyBoundaryIntegration, type Operation } from "@/shared/lib/sentryPrivacy";
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

/** Where the browser SDK posts envelopes; served by app/monitoring/route.ts. */
export const SENTRY_TUNNEL_PATH = "/monitoring";

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

// Reporting callers and automatic-capture deduplication share one registry.
const markReported = scrubber.markReported;
export const isReported = scrubber.isReported;


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
 * An error that is deliberately NOT sent (another runtime already reported
 * it), marked so the console bridge and the global handlers do not send it
 * either when a screen logs or rethrows it.
 */
export function markErrorHandled(error: unknown): void {
    // Same registry as a real report: `isReported` must also say yes, or a
    // screen's notifyError would file the incident the server already filed.
    markReported(error);
}

/**
 * A backend 5xx seen from the browser. The request id is the same one the
 * backend attached to its own event, so the two sides of one failure can be
 * matched in Sentry by searching `request_id:<id>`.
 */
/** Report an API failure immediately with the operation known by its caller. */
export function reportApiFailure(failure: {
    path: string;
    status: number;
    code?: string | null;
    requestId?: string | null;
    method?: string;
    operation?: Operation;
    error?: unknown;
}): string | null {
    if (isReported(failure.error)) return null;
    markReported(failure.error);
    if (!Sentry.isEnabled()) return null;
    const route = normalizeApiPath(failure.path);
    const method = failure.method ?? "GET";
    return Sentry.withScope(scope => {
        applyContext(scope, {
            level: "error",
            tags: {
                component: "mike-api",
                operation: failure.operation,
                http_status: failure.status,
                http_method: method,
                http_route: route,
                request_id: failure.requestId,
                error_code: failure.code,
                ...(route === "/observability/sentry-test" ? { diagnostic_test: "true" } : {}),
            },
            fingerprint: ["api-5xx", method, route, String(failure.status)],
        });
        return Sentry.captureMessage(`API ${failure.status} on ${method} ${route}`, "error");
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
 * How long one "API unreachable" report stands for further unreachable
 * failures on the same page. When the backend is down, every screen fires
 * several requests at mount (profile, models, projects, chats…) and each
 * one fails with the same bare TypeError in the same second (MIKE-FRONTEND
 * -C and -G: /api/models/:id and /api/projects/:id failed 5 ms apart). Per
 * route, that is five issues and five events for one outage, and none of
 * them points at a route because no route is at fault: the server is.
 *
 * So the first unreachable failure reports, and the ones that follow within
 * this window are only counted; the count rides on the next report (tag
 * `network_failure_count`). One minute matches the scrubber's per-issue
 * throttle window, so a sustained outage costs one event per page per
 * minute instead of up to ten per route per minute.
 */
export const API_UNREACHABLE_WINDOW_MS = 60_000;
let unreachableReportedAt: number | null = null;
let unreachableSuppressed = 0;

/** Test seam: forget the current outage window. */
export function resetApiUnreachableWindow(): void {
    unreachableReportedAt = null;
    unreachableSuppressed = 0;
}

/**
 * Fetch failed without an HTTP response. Browser errors alone cannot tell
 * whether the request reached the server, or distinguish TLS, CORS, a dropped
 * connection, and a failed response read.
 *
 * The fetch spec rejects every network-level failure with a TypeError (the
 * message differs per browser: "Failed to fetch", "Load failed",
 * "NetworkError…"). That is reported as ONE "API unreachable" issue per
 * outage window per page, not one per endpoint (API_UNREACHABLE_WINDOW_MS).
 * It is sent without the exception's stack: the privacy boundary groups by
 * the default (stack) hash plus the route tag, and the stack of a failed
 * fetch is only whichever screen asked, so either would split one outage
 * into an issue per caller. Anything else the request layer throws is a
 * bug, not an outage, and keeps its per-route issue. Real HTTP 5xx
 * responses go through reportApiFailure, per route, unaffected.
 *
 * Not reported while the page is being left (cancellations of the old
 * page's requests) or while the browser says it is offline (the user's
 * connection, not the server). The error is still marked so a screen's
 * later console.error of it is not bridged either.
 */
export function reportNetworkFailure(
    error: unknown,
    request: { method: string; url: string; operation?: Operation },
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
    if (networkState === "offline") return null;
    if (error instanceof TypeError) {
        const now = Date.now();
        if (
            unreachableReportedAt !== null &&
            now - unreachableReportedAt < API_UNREACHABLE_WINDOW_MS
        ) {
            unreachableSuppressed += 1;
            return null;
        }
        // This failure plus every one folded into the previous window.
        const failureCount = unreachableSuppressed + 1;
        unreachableReportedAt = now;
        unreachableSuppressed = 0;
        return Sentry.withScope((scope) => {
            applyContext(scope, {
                level: "warning",
                tags: {
                    component: "mike-api",
                    operation: request.operation,
                    stage: "api-unreachable",
                    network: true,
                    network_state: networkState,
                    request_origin: requestOrigin,
                    network_failure_count: failureCount,
                },
                fingerprint: ["api-unreachable"],
            });
            // captureEvent, not captureException/captureMessage: neither the
            // error's stack nor attachStacktrace's synthetic call-site stack
            // may reach the grouping hash. The hint still carries the error
            // so the scrubber derives failure_code (fetch_failed) from it.
            return Sentry.captureEvent(
                { message: "API unreachable", level: "warning" },
                { originalException: error },
            );
        });
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
 * them in. Reporting policy and destination belong to the server tunnel.
 */
export function browserSentryOptions(env: {
    install?: string;
    environment?: string;
    release?: string;
    version?: string;
    gitSha?: string;
    tracesSampleRate?: string;
    nodeEnv?: string;
}): Sentry.BrowserOptions {
    return {
        // The SDK requires a valid DSN even with a tunnel. This placeholder
        // never chooses the destination: /monitoring rewrites it. Always
        // initialize so a runtime override can enable a baked-off image.
        dsn: MIKE_SENTRY_DSN.frontend,
        enabled: true,
        environment: env.environment?.trim() || "self-hosted",
        release: releaseName(env.release, env.version, env.gitSha),
        // Every browser envelope goes through the Next server (see
        // app/monitoring/route.ts), which applies the deployment's runtime
        // opt-out and DSN before forwarding. The placeholder DSN above is only
        // what the SDK needs to be enabled; the server decides where it goes.
        tunnel: SENTRY_TUNNEL_PATH,
        tracesSampleRate: parseSampleRate(env.tracesSampleRate, 0),
        // Session replay is deliberately NOT enabled: it would record
        // privileged document text on screen.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            httpBodies: [],
            urlQueryParams: false,
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            graphQL: { document: false, variables: false },
            stackFrameVariables: false,
            frameContextLines: 0,
        },
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

export type ReportingDestination = {
    /** Empty when reporting is off. */
    dsn: string;
    source: "disabled" | "runtime" | "build" | "default";
    /** For `source: "disabled"`: which variable switched reporting off. */
    disabledBy?: "runtime" | "build";
    /** Runtime overrides for every report; absent means "as built". */
    environment?: string;
    install?: ReturnType<typeof installKind>;
};

/**
 * The ONE place that decides where the web app's error reports go: the Next
 * server's own events and every browser envelope (tunneled through
 * app/monitoring/route.ts) use this, so they can never diverge. Read at
 * runtime on the Next server, in this order:
 *
 *   SENTRY_DISABLED=true          off, browser included
 *   NEXT_PUBLIC_SENTRY_DISABLED   baked default when SENTRY_DISABLED is empty
 *   SENTRY_DSN                    the deployment's project (FRONTEND_SENTRY_DSN in compose)
 *   NEXT_PUBLIC_SENTRY_DSN        the project baked in at image build, for images
 *                                 built with a DSN and run without the runtime one
 *   otherwise                     the built-in Mike project (community default)
 *
 * The result is printed at boot (sentry.server.config.ts) and answered by
 * GET /monitoring, so an operator can see which rule applied.
 */
export function reportingDestination(env: NodeJS.ProcessEnv): ReportingDestination {
    const overrides = {
        ...(env.SENTRY_ENVIRONMENT?.trim() ? { environment: env.SENTRY_ENVIRONMENT.trim() } : {}),
        ...(env.SENTRY_INSTALL?.trim() ? { install: installKind(env.SENTRY_INSTALL) } : {}),
    };
    // An explicit runtime value (true or false) wins over the image's baked
    // default; the shipped .env sets SENTRY_DISABLED=false deliberately.
    const runtimeDisabled = env.SENTRY_DISABLED?.trim();
    const runtimeDsn = env.SENTRY_DSN?.trim();
    const buildDsn = env.NEXT_PUBLIC_SENTRY_DSN?.trim();
    // Same "what counts as off / which DSN" rule as the browser, backend and
    // add-in, so the four runtimes cannot drift apart.
    const resolved = resolveDsn({
        disabled: runtimeDisabled || env.NEXT_PUBLIC_SENTRY_DISABLED?.trim(),
        dsn: runtimeDsn || buildDsn,
        fallback: MIKE_SENTRY_DSN.frontend,
    });
    if (resolved.source === "disabled") {
        return {
            dsn: "",
            source: "disabled",
            disabledBy: runtimeDisabled ? "runtime" : "build",
            ...overrides,
        };
    }
    if (resolved.source === "env") {
        return { dsn: resolved.dsn, source: runtimeDsn ? "runtime" : "build", ...overrides };
    }
    return { dsn: resolved.dsn, source: "default", ...overrides };
}

/** One line for the boot log: which rule applied, never the DSN's key. */
export function describeReportingDestination(destination: ReportingDestination): string {
    const project = (() => {
        try {
            return new URL(destination.dsn).pathname.replace(/^\/+/, "") || "?";
        } catch {
            return "?";
        }
    })();
    switch (destination.source) {
        case "disabled":
            return destination.disabledBy === "runtime"
                ? "[sentry] web app reports: off (SENTRY_DISABLED=true at runtime), browser included"
                : "[sentry] web app reports: off (NEXT_PUBLIC_SENTRY_DISABLED=true baked at build; set SENTRY_DISABLED=false to override), browser included";
        case "runtime":
            return `[sentry] web app reports → SENTRY_DSN project ${project} (runtime), browser included`;
        case "build":
            return `[sentry] web app reports → NEXT_PUBLIC_SENTRY_DSN project ${project} (baked at build; set SENTRY_DSN to change it at runtime), browser included`;
        default:
            return "[sentry] web app reports → Mike project Sentry (community default), browser included. Opt out with SENTRY_DISABLED=true or point SENTRY_DSN at your own project.";
    }
}

/** Server / edge SDK options; env is read at runtime on the Next server. */
export function serverSentryOptions(
    runtime: "server" | "edge",
    env: NodeJS.ProcessEnv,
): Sentry.NodeOptions {
    const { dsn } = reportingDestination(env);
    return {
        dsn: dsn || undefined,
        enabled: dsn.length > 0,
        environment: env.SENTRY_ENVIRONMENT?.trim() || "self-hosted",
        integrations: [privacyBoundaryIntegration()],
        release: releaseName(env.SENTRY_RELEASE, env.MIKE_VERSION, env.GIT_SHA),
        tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            httpBodies: [],
            urlQueryParams: false,
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            graphQL: { document: false, variables: false },
            stackFrameVariables: false,
            frameContextLines: 0,
        },
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
