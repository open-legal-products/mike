/**
 * Error reporting for the Word add-in. Same policy as the web app (see
 * frontend/src/app/lib/errorReporting.ts and the shared scrubber it uses):
 * on by default with a community privacy policy, every console.error bridged,
 * explicit reports deduplicated against the bridge.
 *
 * The add-in adds one thing the web app does not have: the Office host. A
 * bug that only reproduces in Word on Mac 16.x or Word on the web is
 * invisible without those tags, so they are attached as soon as Office.js
 * reports them.
 */
import * as Sentry from "@sentry/react";
import { privacyBoundaryIntegration } from "@mike/sentry-event";
import {
  MIKE_SENTRY_DSN,
  createEventScrubber,
  installKind,
  normalizeApiPath,
  parseSampleRate,
  releaseName,
  resolveDsn,
} from "@mike/sentry-event";

export type ReportLevel = "fatal" | "error" | "warning";

/**
 * The user-level flows of the add-in, named the way the privacy boundary
 * (frontend/src/shared/lib/sentryPrivacy.ts, OPERATIONS) knows them. The
 * `operation` tag puts the flow in the event title ("Failure in
 * word.edit_apply / word-office / GeneralException") and in the grouping;
 * a value missing from the boundary's list is dropped there, so add it to
 * the shared vocabulary first, then here.
 */
export const ADDIN_OPERATIONS = [
  "word.session",
  "word.document_read",
  "word.edit_apply",
  "word.edit_resolve",
  "word_chat.turn",
  "workflows.run",
  "quick_actions.run",
  "playbooks.review",
  "settings.keys",
  "documents.upload",
  "documents.directory",
] as const;
export type AddinOperation = (typeof ADDIN_OPERATIONS)[number];

export type ReportContext = {
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
  level?: ReportLevel;
  fingerprint?: string[];
};

const scrubber = createEventScrubber({
  install: installKind(process.env.REACT_APP_SENTRY_INSTALL),
});

export const scrubEvent = scrubber.scrubEvent;

/**
 * The scrubber's "already sent" registry is a closure, so it can answer the
 * console bridge but not a caller. This mirror answers callers: a screen
 * that shows an error the API client already reported (every 5xx, every
 * transport failure) or that `reportWordFailure` already filed must not
 * report it a second time under its own tags.
 */
const reportedHere = new WeakSet<object>();

function markReported(error: unknown): void {
  scrubber.markReported(error);
  if (error && typeof error === "object") reportedHere.add(error);
}

/** Has this exact error object already been sent to Sentry with context? */
export function isReported(error: unknown): boolean {
  return error !== null && typeof error === "object" && reportedHere.has(error);
}

/** `service`/`surface` distinguish the pane from its ribbon and OAuth pages. */
export type AddinSurface = "taskpane" | "commands" | "oauth-dialog";

export function addinSentryOptions(
  surface: AddinSurface,
  env: {
    disabled?: string;
    dsn?: string;
    install?: string;
    environment?: string;
    release?: string;
    gitSha?: string;
    tracesSampleRate?: string;
    nodeEnv?: string;
  },
): Sentry.BrowserOptions {
  // ON BY DEFAULT: the Mike project's own DSN unless REACT_APP_SENTRY_DISABLED
  // or a DSN of your own is baked in at build time (README, "Telemetry").
  const { dsn } = resolveDsn({
    disabled: env.disabled,
    dsn: env.dsn,
    fallback: MIKE_SENTRY_DSN.wordAddin,
  });
  const dataCollection = {
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
        };
  return {
    dsn: dsn || undefined,
    enabled: dsn.length > 0,
    environment: env.environment?.trim() || "self-hosted",
    release: releaseName(env.release, env.gitSha),
    tracesSampleRate: parseSampleRate(env.tracesSampleRate, 0),
    // No session replay: the pane sits next to a privileged document.
    dataCollection,
    attachStacktrace: true,
    integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
    initialScope: {
      tags: {
        service: "mike-word-addin",
        surface,
        build_mode: env.nodeEnv,
        diagnostics_version: "2",
        install: installKind(env.install),
      },
    },
    beforeSend: scrubEvent,
  };
}

/** Initialise once per bundle entry (task pane, commands, OAuth dialog). */
export function initAddinErrorReporting(surface: AddinSurface): boolean {
  const options = addinSentryOptions(surface, {
    disabled: process.env.REACT_APP_SENTRY_DISABLED,
    dsn: process.env.REACT_APP_SENTRY_DSN,
    install: process.env.REACT_APP_SENTRY_INSTALL,
    environment: process.env.REACT_APP_SENTRY_ENVIRONMENT,
    release: process.env.REACT_APP_SENTRY_RELEASE,
    gitSha: process.env.REACT_APP_GIT_SHA,
    tracesSampleRate: process.env.REACT_APP_SENTRY_TRACES_SAMPLE_RATE,
    nodeEnv: process.env.NODE_ENV,
  });
  if (!options.enabled) return false;
  Sentry.init(options);
  return true;
}

/**
 * Tag every event with the Office host once Office.js knows it. Called from
 * Office.onReady; a pane running outside Office (the e2e harness) simply
 * has no diagnostics and gets no tags.
 */
export function tagOfficeHost(): void {
  if (!Sentry.isEnabled()) return;
  const diagnostics = (
    globalThis as {
      Office?: {
        context?: {
          diagnostics?: { host?: unknown; platform?: unknown; version?: unknown };
        };
      };
    }
  ).Office?.context?.diagnostics;
  if (!diagnostics) return;
  const scope = Sentry.getCurrentScope();
  if (diagnostics.host != null) scope.setTag("office_host", String(diagnostics.host));
  if (diagnostics.platform != null) {
    scope.setTag("office_platform", String(diagnostics.platform));
  }
  if (diagnostics.version != null) {
    scope.setTag("office_version", String(diagnostics.version));
  }
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

/** Report BEFORE the accompanying console.error (bridge dedupe). */
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
 * An Office.js failure: Word refused a call or lost a proxy while the pane
 * was reading, anchoring, resolving, restoring, or revealing a tracked
 * change. This is the product's distinctive risk surface and it varies by
 * host (Word desktop, Mac, web — tagged by tagOfficeHost), so every such
 * failure is reported, grouped by `stage` and by Word's own error code.
 * Documented stale-proxy fallbacks that the code retries are NOT failures
 * and must not call this.
 */
export function reportWordFailure(
  error: unknown,
  context: {
    /**
     * Low-cardinality step name: "resolve", "restore", "reveal", ... Omit
     * for a step the vocabulary has no name for (applying an edit); the
     * operation then carries the grouping on its own.
     */
    stage?: string;
    /** The user-level flow: reading the document, applying or resolving an edit. */
    operation?: AddinOperation;
    level?: ReportLevel;
    extra?: Record<string, unknown>;
  },
): string | null {
  const officeCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  const name =
    error instanceof Error ? error.name : officeCode ?? "UnknownWordError";
  return reportError(error, {
    level: context.level ?? "error",
    tags: {
      component: "word-office",
      operation: context.operation,
      stage: context.stage,
      office_code: officeCode,
    },
    extra: context.extra,
    fingerprint: [
      "word-office",
      context.stage ?? context.operation ?? "",
      officeCode ?? name,
    ],
  });
}

/** A backend 5xx seen from the pane, correlated by the backend's request id. */
export function reportApiFailure(failure: {
  path: string;
  status: number;
  code?: string | null;
  requestId?: string | null;
  method?: string;
  /** The user-level flow the request belonged to, when the caller knows it. */
  operation?: AddinOperation;
  /** The error about to be thrown; its later console.error copy is dropped. */
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
        operation: failure.operation,
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
 * The request never reached the server (dead backend, blocked origin, TLS).
 * Not a code bug, but in a Word pane it is the failure users see most and
 * cannot diagnose, so it is tracked as a warning grouped per endpoint.
 */
export function reportNetworkFailure(
  error: unknown,
  request: { method: string; url: string; operation?: AddinOperation },
): string | null {
  markReported(error);
  if (!Sentry.isEnabled()) return null;
  const route = normalizeApiPath(request.url);
  return Sentry.withScope((scope) => {
    applyContext(scope, {
      level: "warning",
      tags: {
        component: "mike-api",
        operation: request.operation,
        network: true,
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

export const ErrorBoundary = Sentry.ErrorBoundary;
