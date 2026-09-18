/**
 * Error reporting for the web app: a thin, testable layer over the Sentry
 * SDK. Application code calls these helpers instead of `@sentry/nextjs`
 * directly so the PII policy (see `@/shared/lib/sentryEvent`) and the
 * "no-op without a DSN" rule live in one place.
 */

import * as Sentry from "@sentry/nextjs";
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
    scrubber.markReported(error);
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
    scrubber.markReported(failure.error);
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
 * The request never reached the server: the backend is down, the origin
 * is blocked, TLS failed, the network dropped. Not a bug in this code, but
 * it is the failure users see most and it was previously reported only
 * through the console bridge as one undifferentiated "Failed to fetch"
 * issue with no endpoint. Warning level, grouped per endpoint.
 */
export function reportNetworkFailure(
    error: unknown,
    request: { method: string; url: string },
): string | null {
    scrubber.markReported(error);
    if (!Sentry.isEnabled()) return null;
    const route = normalizeApiPath(request.url);
    return Sentry.withScope((scope) => {
        applyContext(scope, {
            level: "warning",
            tags: {
                component: "mike-api",
                network: true,
                http_method: request.method,
                http_route: route,
            },
            extra: { url: request.url },
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
        integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
        initialScope: {
            tags: {
                service: "mike-frontend",
                runtime: "browser",
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
        release: releaseName(env.SENTRY_RELEASE, env.GIT_SHA),
        tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
        sendDefaultPii: false,
        initialScope: {
            tags: {
                service: "mike-frontend",
                runtime,
                install: installKind(env.SENTRY_INSTALL),
            },
        },
        beforeSend: scrubEvent,
    };
}
