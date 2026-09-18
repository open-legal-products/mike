// Sentry error tracking for every backend runtime: the API process, the
// in-process worker thread, the standalone worker process, and one-shot jobs.
//
// Design rules, in priority order:
//
//   1. OFF BY DEFAULT. Without SENTRY_DSN nothing here does anything — no
//      network, no instrumentation, no behavior change. Open-source installs
//      and the unit-test suite never contact Sentry.
//   2. NEVER LEAK DOCUMENT CONTENT OR CREDENTIALS. This is a legal platform:
//      request bodies carry privileged documents and chat transcripts, and
//      headers carry session cookies. `beforeSend` strips request bodies,
//      cookies, and auth headers, and redacts secret-looking keys anywhere
//      in an event. `sendDefaultPii` stays false.
//   3. ONE EVENT PER FAILURE. Explicit `reportError` calls at the boundaries
//      (HTTP 500 path, background jobs, stream failures, worker crashes) carry
//      structured tags; a console bridge turns every remaining `console.error`
//      into an event so nothing is silently dropped. Errors already reported
//      explicitly are remembered so the bridge does not double-report them.

import * as Sentry from "@sentry/node";

export type SentryRole = "api" | "worker" | "worker-thread" | "job";

export type ReportLevel = "fatal" | "error" | "warning";

export type ReportContext = {
  /** Sentry tags: low-cardinality, indexed, filterable in the UI. */
  tags?: Record<string, string | number | boolean | null | undefined>;
  /** Free-form structured context shown on the event; scrubbed before send. */
  extra?: Record<string, unknown>;
  level?: ReportLevel;
  /** Override Sentry's grouping when the message alone would split issues. */
  fingerprint?: string[];
};

const CONSOLE_MECHANISM = "auto.core.capture_console";
const NESTED_SEARCH_DEPTH = 2;

// BEGIN shared-redaction
// This block is the privacy control for every runtime. It is authored once
// and mirrored, indentation aside, between backend/src/lib/observability/
// sentry.ts and frontend/src/shared/lib/sentryEvent.ts (the backend cannot
// import the frontend tree at build time). sentryEvent.sync.test.ts fails
// the moment the two copies differ, so edit both or neither.
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-supabase-auth",
]);
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i;
const MAX_SCRUB_DEPTH = 6;
/**
 * Query parameters whose VALUE is a credential, plus the two OAuth callback
 * parameters (an authorization code is single-use but still a credential
 * until it is exchanged) and S3 presigned-URL signature fields.
 */
const SENSITIVE_QUERY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key|signature|^code$|^state$|^sig$|^x-amz-(signature|credential|security-token)$)/i;
/** Path segments whose NEXT segment is a token: GET /download/<token>. */
const TOKEN_PATH_SEGMENTS = new Set(["download"]);
/** Keys whose string value is a path or URL: redactUrl sees bare paths too. */
const URL_KEY_PATTERN =
  /^(url|href|path|query_string|referer|referrer|location|redirect(_uri)?)$/i;

/**
 * Strip credentials from a URL or path while keeping it recognisable:
 * `/download/<token>` → `/download/[Filtered]`, `?code=…&state=…` →
 * `?code=[Filtered]&state=[Filtered]`.
 */
export function redactUrl(value: string): string {
  const queryStart = value.indexOf("?");
  const pathPart = queryStart === -1 ? value : value.slice(0, queryStart);
  const query = queryStart === -1 ? null : value.slice(queryStart + 1);
  const segments = pathPart.split("/");
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (
      segment !== undefined &&
      TOKEN_PATH_SEGMENTS.has(segment) &&
      segments[i + 1]
    ) {
      segments[i + 1] = "[Filtered]";
    }
  }
  let out = segments.join("/");
  if (query !== null) {
    out += `?${redactQueryString(query)}`;
  }
  return out;
}

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      // Idempotent: text redaction may run over an already scrubbed URL.
      if (pair.endsWith("=[Filtered]")) return pair;
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        // Keep the raw key; it still gets pattern-matched below.
      }
      return SENSITIVE_QUERY_PATTERN.test(name) ? `${key}=[Filtered]` : pair;
    })
    .join("&");
}

/** The SDK may hand query parameters over as a string, a map, or pairs. */
function redactQueryParams(value: unknown): unknown {
  if (typeof value === "string") return redactQueryString(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      Array.isArray(entry) && typeof entry[0] === "string"
        ? SENSITIVE_QUERY_PATTERN.test(entry[0])
          ? [entry[0], "[Filtered]"]
          : entry
        : entry,
    );
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as object)) {
      out[key] = SENSITIVE_QUERY_PATTERN.test(key) ? "[Filtered]" : entry;
    }
    return out;
  }
  return value;
}

/**
 * Secrets and identities that appear INSIDE free text: a Postgres error
 * quoting the email it collided on, an HTTP client echoing an Authorization
 * header, a provider key in a stack frame, a presigned URL in a log line.
 * Key-based filtering cannot see any of these, so every string that lands
 * on an event — the title, the exception text, extras, breadcrumbs — goes
 * through here. Order matters: URLs first so their query strings are
 * handled by redactUrl, then bearer tokens before the bare-JWT pattern.
 */
const TEXT_PATTERNS: Array<[RegExp, string | ((match: string) => string)]> = [
  [/https?:\/\/[^\s"'<>]+/g, (match) => redactUrl(match)],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Filtered]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*)?/g, "[jwt]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[api-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[github-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[slack-token]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Keys allowed under `extra` and breadcrumb data, at any depth. Everything
 * else is replaced, not only secret-looking keys: an `extra.note` holding a
 * contract clause has no telltale name, and the console bridge copies whole
 * logged objects into `extra.arguments`. The list is the ids and error
 * fields this codebase actually attaches; extend it deliberately.
 */
const EXTRA_KEY_ALLOWLIST = new Set([
  "arguments",
  "body",
  "bookmarkName",
  "code",
  "dedupe_key",
  "detail",
  "document_id",
  "documentId",
  "err",
  "error",
  "error_stack",
  "exit_code",
  "file_id",
  "fileId",
  "id",
  "job_id",
  "jobId",
  "kind",
  "message",
  "name",
  "path",
  "request_id",
  "requestId",
  "review_id",
  "reviewId",
  "row_id",
  "rowId",
  "session_id",
  "sessionId",
  "stableEditId",
  "stack",
  "stage",
  "status",
  "statusCode",
  "tool",
  "tool_call_id",
  "unhandledPromiseRejection",
  "url",
  "version_id",
  "versionId",
  "worker_id",
  "workerId",
]);

/** A string leaf: bare paths under URL-shaped keys get redactUrl as well. */
function redactLeaf(key: string, value: string): string {
  return redactText(URL_KEY_PATTERN.test(key) ? redactUrl(value) : value);
}

/** Free-form application data (extra, breadcrumb data): allowlist + text. */
export function scrubFreeform(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return "[Truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubFreeform(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as object)) {
      out[key] =
        EXTRA_KEY_ALLOWLIST.has(key) && !SENSITIVE_KEY_PATTERN.test(key)
          ? typeof entry === "string"
            ? redactLeaf(key, entry)
            : scrubFreeform(entry, depth + 1)
          : "[Filtered]";
    }
    return out;
  }
  return value;
}

/** SDK-shaped data (contexts: os, runtime, device…): denylist + text. */
export function redactShaped(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return "[Truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactShaped(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as object)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[Filtered]"
        : typeof entry === "string"
          ? redactLeaf(key, entry)
          : redactShaped(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The Mike project's own Sentry projects. A DSN is a write-only address:
 * it lets an SDK post events and nothing else, so it is public by design
 * (it ships in every browser bundle). Community installs report here by
 * default so the project learns what forks run into; the opt-out and the
 * override are one variable each (see resolveDsn).
 */
export const MIKE_SENTRY_DSN = {
  backend:
    "https://c755fbcd344e1d4ac0dfc3b3c927b938@o4512103319207936.ingest.us.sentry.io/4512103323074560",
  frontend:
    "https://b5a10f7549e6bd0165d4e01d67e762cd@o4512103319207936.ingest.us.sentry.io/4512103326416896",
  wordAddin:
    "https://dcb3daf9d26bb576e94da2c584de63e8@o4512103319207936.ingest.us.sentry.io/4512103330349056",
} as const;

export type DsnResolution = {
  dsn: string;
  /** Where the DSN came from; "default" means the Mike project's Sentry. */
  source: "disabled" | "env" | "default";
};

/**
 * Off if the runtime's *_SENTRY_DISABLED is "true"; the runtime's own DSN
 * when one is set (a self-hoster's own Sentry); otherwise the built-in Mike
 * project DSN. Test processes are guarded separately by the caller.
 */
export function resolveDsn(input: {
  disabled?: string;
  dsn?: string;
  fallback: string;
}): DsnResolution {
  if (input.disabled?.trim().toLowerCase() === "true") {
    return { dsn: "", source: "disabled" };
  }
  const explicit = input.dsn?.trim();
  if (explicit) return { dsn: explicit, source: "env" };
  return { dsn: input.fallback, source: "default" };
}

export type InstallKind = "official" | "community";

/** Only the official deployment sets SENTRY_INSTALL=official; all else is community. */
export function installKind(raw: string | undefined): InstallKind {
  return raw?.trim().toLowerCase() === "official" ? "official" : "community";
}

type CommunityFrame = {
  filename?: unknown;
  abs_path?: unknown;
  in_app?: unknown;
  vars?: unknown;
  pre_context?: unknown;
  context_line?: unknown;
  post_context?: unknown;
};
type CommunityEvent = {
  server_name?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
  message?: unknown;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  request?: { url?: unknown; method?: unknown } & Record<string, unknown>;
  exception?: {
    values?: { value?: unknown; stacktrace?: { frames?: CommunityFrame[] } }[];
  };
};

const REPO_ROOTS = ["/backend/", "/frontend/", "/word-addin/", "/packages/"];
/** Contexts broad enough not to identify anyone; each reduced to name + version. */
const COMMUNITY_CONTEXTS = new Set(["os", "runtime", "browser", "trace"]);
const FILESYSTEM_PATH_PATTERN =
  /(?:\/(?:Users|home|app|var|tmp|opt|private|srv|mnt|data|root|etc)\/[^\s"'`)\]]*)|(?:[A-Za-z]:\\[^\s"'`)\]]*)/g;

/**
 * A code location without the machine it was found on: everything before
 * the repository directory (`/Users/jane/work/mike/backend/src/x.ts` →
 * `backend/src/x.ts`), the dependency path for node_modules, the URL path
 * for browser bundles, and "[external]" for anything outside the project.
 */
export function repoRelativePath(path: string): string {
  let idx = -1;
  for (const root of REPO_ROOTS) {
    const at = path.lastIndexOf(root);
    if (at > idx) idx = at;
  }
  if (idx >= 0) return path.slice(idx + 1);
  const nm = path.lastIndexOf("/node_modules/");
  if (nm >= 0) return path.slice(nm + 1);
  if (/^https?:\/\//.test(path)) return path.replace(/^https?:\/\/[^/]+/, "") || "/";
  if (/^(webpack|app|node|file):/.test(path)) return path.replace(/^file:\/\/[^/]*/, "");
  const src = path.lastIndexOf("/src/");
  if (src >= 0) return path.slice(src + 1);
  const dist = path.lastIndexOf("/dist/");
  if (dist >= 0) return path.slice(dist + 1);
  return "[external]";
}

/** Absolute filesystem paths inside free text → repo-relative or "[path]". */
export function redactFilesystemPaths(text: string): string {
  return text.replace(FILESYSTEM_PATH_PATTERN, (match) => {
    const relative = repoRelativePath(match);
    return relative === "[external]" ? "[path]" : relative;
  });
}

function mapStringLeaves(
  value: unknown,
  fn: (text: string) => string,
  depth = 0,
): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) {
    return value.map((item) => mapStringLeaves(item, fn, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as object)) {
      out[key] = mapStringLeaves(entry, fn, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * COMMUNITY INSTALLS: a fork or self-hosted Mike reporting to the Mike
 * project's Sentry sends only what our own code owns and what is too broad
 * to identify anyone. Removed: the machine name, the user id, request
 * headers and host, every breadcrumb, device / app / locale contexts, local
 * variables, and any absolute filesystem path (in frames, messages, extras).
 * Kept: repo-relative code locations with their source lines, our own tags
 * and ids, the route pattern, OS / runtime / browser name and version,
 * environment and release.
 */
export function minimiseForCommunity<T extends CommunityEvent>(event: T): T {
  delete event.server_name;
  delete event.user;
  delete event.breadcrumbs;
  if (event.tags) {
    delete event.tags.server_name;
    delete event.tags.url;
  }
  if (event.request) {
    const url =
      typeof event.request.url === "string"
        ? event.request.url.replace(/^https?:\/\/[^/]+/, "")
        : undefined;
    const method = event.request.method;
    event.request = {
      ...(typeof method === "string" ? { method } : {}),
      ...(url ? { url } : {}),
    };
  }
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!COMMUNITY_CONTEXTS.has(key)) {
        delete event.contexts[key];
        continue;
      }
      const context = event.contexts[key];
      if (key !== "trace" && context && typeof context === "object") {
        const { name, version } = context as { name?: unknown; version?: unknown };
        event.contexts[key] = {
          ...(name !== undefined ? { name } : {}),
          ...(version !== undefined ? { version } : {}),
        };
      }
    }
  }
  if (typeof event.message === "string") {
    event.message = redactFilesystemPaths(event.message);
  }
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") {
      value.value = redactFilesystemPaths(value.value);
    }
    for (const frame of value.stacktrace?.frames ?? []) {
      if (typeof frame.filename === "string") {
        frame.filename = repoRelativePath(frame.filename);
      }
      if (typeof frame.abs_path === "string") {
        frame.abs_path = repoRelativePath(frame.abs_path);
      }
      delete frame.vars;
      if (frame.in_app !== true) {
        delete frame.pre_context;
        delete frame.context_line;
        delete frame.post_context;
      }
    }
  }
  if (event.extra) {
    event.extra = mapStringLeaves(event.extra, redactFilesystemPaths) as Record<
      string,
      unknown
    >;
  }
  return event;
}
// END shared-redaction

/** Errors already sent via reportError(); the console bridge skips them. */
const reportedErrors = new WeakSet<object>();

let initialized = false;
/** What this process is; community installs get the minimised event shape. */
let currentInstall: InstallKind = "community";

function parseRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

export function sentryConfiguration(env: NodeJS.ProcessEnv = process.env) {
  // ON BY DEFAULT: without SENTRY_DISABLED or a DSN of your own, errors go
  // to the Mike project's Sentry as a community install (see the README's
  // Telemetry section). Only Mike's own deployment sets SENTRY_INSTALL.
  const resolved = resolveDsn({
    disabled: env.SENTRY_DISABLED,
    dsn: env.SENTRY_DSN,
    fallback: MIKE_SENTRY_DSN.backend,
  });
  const dsn = resolved.dsn;
  // A test process must never report, even when a developer's backend/.env
  // carries a real DSN: the suite deliberately points workers at dead ports
  // and would flood the project with fake failures.
  const isTestProcess =
    env.NODE_ENV === "test" || env.VITEST === "true" || env.VITEST === "1";
  return {
    dsn,
    dsnSource: resolved.source,
    install: installKind(env.SENTRY_INSTALL),
    enabled:
      dsn.length > 0 &&
      (!isTestProcess || env.SENTRY_ALLOW_IN_TESTS === "true"),
    environment: env.SENTRY_ENVIRONMENT?.trim() || "self-hosted",
    // An explicit SENTRY_RELEASE wins; otherwise the git commit the image
    // was built from (GIT_SHA, a Dockerfile build arg) — what lets Sentry
    // say "regressed in this deploy" and resolve an issue until the next.
    release:
      env.SENTRY_RELEASE?.trim() ||
      (env.GIT_SHA?.trim() ? `mike@${env.GIT_SHA.trim().slice(0, 12)}` : undefined),
    // Performance tracing is opt-in: error tracking is the goal of this
    // integration and traces cost quota. 0 keeps the OpenTelemetry request
    // instrumentation (needed for request context on errors) without
    // sending transactions.
    tracesSampleRate: parseRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
    debug: env.SENTRY_DEBUG === "true",
    maxEventsPerIssuePerMinute: envInt(
      env.SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE,
      DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE,
    ),
  };
}

function envInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * CLIENT-SIDE FLOOD CONTROL. A background loop that fails on every poll
 * (Postgres down, 8 upload workers, sub-second retry) produces hundreds of
 * identical events a minute — one is a signal, five hundred are a quota bill
 * and a rate-limited SDK that then drops the *next, different* error. Sentry
 * only deduplicates strictly consecutive identical events, so this keeps a
 * per-issue budget per minute and drops the excess locally, logging once per
 * window how many were suppressed.
 */
const DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;
type ThrottleBucket = { windowStart: number; sent: number; suppressed: number };
const throttleBuckets = new Map<string, ThrottleBucket>();
let maxEventsPerIssuePerMinute = DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;

function issueKey(event: Sentry.ErrorEvent): string {
  if (event.fingerprint?.length) return event.fingerprint.join("|");
  const exception = event.exception?.values?.[0];
  const base = exception
    ? `${exception.type ?? "Error"}: ${exception.value ?? ""}`
    : (event.message ?? "");
  const component = event.tags?.component;
  return `${component == null ? "" : String(component)}::${base.slice(0, 300)}`;
}

/** True when this event is within its issue's per-minute budget. */
export function withinIssueBudget(
  event: Sentry.ErrorEvent,
  now = Date.now(),
): boolean {
  const key = issueKey(event);
  let bucket = throttleBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= THROTTLE_WINDOW_MS) {
    if (bucket?.suppressed) {
      console.warn(
        `[sentry] suppressed ${bucket.suppressed} further event(s) for: ${key.slice(0, 120)}`,
      );
    }
    bucket = { windowStart: now, sent: 0, suppressed: 0 };
    throttleBuckets.set(key, bucket);
    // Keep the map bounded on a long-running process.
    if (throttleBuckets.size > 1_000) {
      for (const [otherKey, other] of throttleBuckets) {
        if (now - other.windowStart >= THROTTLE_WINDOW_MS) {
          throttleBuckets.delete(otherKey);
        }
      }
    }
  }
  if (bucket.sent < maxEventsPerIssuePerMinute) {
    bucket.sent += 1;
    return true;
  }
  bucket.suppressed += 1;
  return false;
}

/** True once init() ran with a DSN in this process (or thread). */
export function isSentryEnabled(): boolean {
  return initialized;
}

function findNested(
  value: unknown,
  predicate: (candidate: object) => boolean,
  depth = 0,
): object | null {
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  if (depth >= NESTED_SEARCH_DEPTH) return null;
  for (const entry of Object.values(value)) {
    const found = findNested(entry, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The console bridge hands its raw `console.error` arguments to beforeSend
 * through the hint; the copy on the event is already normalised by then, so
 * this is the only place the original Error objects can be recognised.
 */
function consoleArguments(hint: Sentry.EventHint): unknown[] | null {
  const context = hint.captureContext as
    | { extra?: { arguments?: unknown } }
    | undefined;
  const args = context?.extra?.arguments;
  return Array.isArray(args) ? args : null;
}

/**
 * Strip everything a legal-platform event must never carry, then drop
 * console-bridge duplicates of errors that were reported explicitly.
 * Exported for tests; installed as `beforeSend`.
 */
export function scrubEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint,
): Sentry.ErrorEvent | null {
  // An error reported explicitly must not be filed a second time by an
  // automatic path: the console bridge's copy, or the unhandled-rejection /
  // uncaught-exception handler's copy when the same object then escapes.
  // Explicit captures arrive with handled: true and are always kept.
  const mechanismInfo = event.exception?.values?.[0]?.mechanism;
  const mechanism = mechanismInfo?.type;
  const automatic =
    mechanism === CONSOLE_MECHANISM || mechanismInfo?.handled === false;
  const original = hint.originalException;
  if (
    automatic &&
    original &&
    typeof original === "object" &&
    reportedErrors.has(original)
  ) {
    return null;
  }

  // console.error("[label] failed", { jobId, error }) is the common shape in
  // this codebase. The bridge only recognises a top-level Error, so it sends
  // this as a message titled "[label] failed [object Object]". Recover: drop
  // it when the nested error was already reported explicitly (most of the
  // boundaries above do exactly that), otherwise give the message the error's
  // name and text and group by label instead of by the serialised object.
  const args = event.logger === "console" ? consoleArguments(hint) : null;
  if (args) {
    if (args.some((arg) => findNested(arg, (c) => reportedErrors.has(c)))) {
      return null;
    }
    const nestedError = args
      .map((arg) =>
        arg instanceof Error
          ? null
          : findNested(arg, (c) => c instanceof Error),
      )
      .find((found): found is Error => found instanceof Error);
    if (nestedError) {
      const label = args
        .filter((arg): arg is string => typeof arg === "string")
        .join(" ")
        .trim();
      event.message = `${label ? `${label}: ` : ""}${nestedError.name}: ${nestedError.message}`;
      event.fingerprint = ["console", label, nestedError.name];
      event.extra = { ...(event.extra ?? {}), error_stack: nestedError.stack };
    }
  }

  // The title and the exception text are free text from libraries that
  // happily quote emails, tokens, and URLs (Postgres "Key (email)=(…)",
  // axios "Request failed … Authorization: Bearer …").
  if (typeof event.message === "string") {
    event.message = redactText(event.message);
  }
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === "string") value.value = redactText(value.value);
  }
  if (event.request) {
    // Bodies are documents, chat turns, passwords. Never.
    delete event.request.data;
    delete event.request.cookies;
    // The URL stays (it says which endpoint), its credentials do not.
    if (typeof event.request.url === "string") {
      event.request.url = redactUrl(event.request.url);
    }
    if (event.request.query_string !== undefined) {
      event.request.query_string = redactQueryParams(
        event.request.query_string,
      ) as typeof event.request.query_string;
    }
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
          delete event.request.headers[name];
        }
      }
    }
  }
  if (event.user) {
    // Keep the id (needed to answer "how many users hit this?"); drop the
    // rest — the SDK can attach email/ip from the request otherwise.
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  if (event.extra) {
    event.extra = scrubFreeform(event.extra) as Record<string, unknown>;
  }
  if (event.contexts) {
    event.contexts = redactShaped(event.contexts) as typeof event.contexts;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(typeof crumb.message === "string"
        ? { message: redactText(crumb.message) }
        : {}),
      ...(crumb.data
        ? { data: scrubFreeform(crumb.data) as Record<string, unknown> }
        : {}),
    }));
  }
  if (currentInstall === "community") {
    minimiseForCommunity(
      event as unknown as Parameters<typeof minimiseForCommunity>[0],
    );
  }
  if (!withinIssueBudget(event)) return null;
  return event;
}

/**
 * Initialise Sentry for this process. Safe to call more than once; returns
 * whether tracking is active. MUST run before Express/HTTP modules load so
 * the request instrumentation can hook them — see src/instrument.ts.
 */
export function initSentry(
  role: SentryRole,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (initialized) return true;
  const config = sentryConfiguration(env);
  if (!config.enabled) {
    if (env.NODE_ENV !== "test") {
      console.log(
        `[sentry] disabled for ${role} (${
          config.dsnSource === "disabled" ? "SENTRY_DISABLED=true" : "test process"
        })`,
      );
    }
    return false;
  }

  maxEventsPerIssuePerMinute = config.maxEventsPerIssuePerMinute;
  currentInstall = config.install;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
    tracesSampleRate: config.tracesSampleRate,
    sendDefaultPii: false,
    // Bodies are stripped in beforeSend as well; not collecting them at all
    // means they never sit in memory on the event either.
    integrations: [
      Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" }),
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
      // Node 22 crashes on an unhandled rejection; the SDK's default "warn"
      // mode registers its own listener, which silently turns that crash
      // into "log and carry on" the moment a DSN is set. A DSN must not
      // change how the process behaves: report the rejection, then exit
      // exactly as an install without Sentry would (the API is restarted by
      // its supervisor, the worker thread is respawned by index.ts).
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
    initialScope: {
      tags: { service: "mike-backend", role, install: config.install },
    },
    beforeSend: scrubEvent,
  });
  initialized = true;
  if (config.dsnSource === "default") {
    console.log(
      `[sentry] enabled for ${role} → Mike project Sentry (${config.install} install). ` +
        "Opt out with SENTRY_DISABLED=true or point SENTRY_DSN at your own project.",
    );
  } else {
    console.log(
      `[sentry] enabled for ${role} (environment ${config.environment}` +
        `${config.release ? `, release ${config.release}` : ""})`,
    );
  }
  return true;
}

/**
 * Report an error with structured context. Call it BEFORE the accompanying
 * console.error so the console bridge recognises the error as already sent.
 * Returns the Sentry event id (useful for correlating with a request id), or
 * null when tracking is off.
 */
export function reportError(
  error: unknown,
  context: ReportContext = {},
): string | null {
  if (error && typeof error === "object") reportedErrors.add(error);
  if (!initialized) return null;
  return Sentry.withScope((scope) => {
    if (context.level) scope.setLevel(context.level);
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
      scope.setExtra(key, value);
    }
    return Sentry.captureException(
      error instanceof Error ? error : new Error(describe(error)),
    );
  });
}

/** A message-only event (no Error object), for "this should never happen". */
export function reportMessage(
  message: string,
  context: ReportContext = {},
): string | null {
  if (!initialized) return null;
  return Sentry.withScope((scope) => {
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
      scope.setExtra(key, value);
    }
    return Sentry.captureMessage(message, context.level ?? "error");
  });
}

/**
 * The Express route PATTERN a request matched, with its mount point:
 * `/projects/:projectId`, not `/projects/8f1c…`. Used as the grouping tag on
 * every HTTP event so one bug is one issue however many resources it hits.
 *
 * `req.route.path` alone is only the router-relative part — `/:id` for both
 * GET /projects/:id and GET /documents/:id — so it must be joined with
 * `req.baseUrl` or unrelated endpoints collapse into one issue. A request
 * that matched no route (404s, errors thrown in app-level middleware) has no
 * pattern; the concrete path minus its query string is the best we have.
 */
export function requestRoutePattern(
  req:
    | {
        baseUrl?: string;
        route?: { path?: unknown };
        originalUrl?: string;
      }
    | undefined,
): string | undefined {
  if (!req) return undefined;
  const base = req.baseUrl ?? "";
  const path = req.route?.path;
  if (typeof path === "string") {
    return path === "/" && base ? base : `${base}${path}`;
  }
  const concrete = req.originalUrl?.split("?")[0];
  return concrete ? `${concrete}` : base || undefined;
}

/**
 * Run work whose failure must not fail the caller — a rollback, a cleanup,
 * a cache refresh — but must not vanish either. `promise.catch(() => {})`
 * is how a storage leak or a half-finished rollback stays invisible for
 * months; this reports it as a warning, grouped per `what`, and resolves
 * to undefined so the caller's control flow is unchanged.
 */
export function bestEffort<T>(
  work: Promise<T>,
  context: {
    /** Stable, low-cardinality name of the operation: the grouping key. */
    what: string;
    tags?: ReportContext["tags"];
    extra?: ReportContext["extra"];
  },
): Promise<T | undefined> {
  return work.catch((error: unknown) => {
    reportError(error, {
      level: "warning",
      tags: { component: "best-effort", ...context.tags, what: context.what },
      extra: context.extra,
      fingerprint: ["best-effort", context.what],
    });
    console.warn(`[best-effort] ${context.what} failed`, {
      ...(context.extra ?? {}),
      error,
    });
    return undefined;
  });
}

/** Attach the request id to every event captured during this request. */
export function tagCurrentRequest(requestId: string): void {
  if (!initialized) return;
  Sentry.getIsolationScope().setTag("request_id", requestId);
}

/** Attach the authenticated user's id (never the email) to this request. */
export function setCurrentUser(userId: string | null): void {
  if (!initialized) return;
  Sentry.getIsolationScope().setUser(userId ? { id: userId } : null);
}

/** Flush queued events before a process exits (one-shot jobs, crashes). */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Exiting anyway; a lost event is better than a hung process.
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Test seam: forget init and throttle state between unit tests. */
export function resetSentryForTests(install: InstallKind = "official"): void {
  initialized = false;
  // Tests exercise the full event shape unless they opt into community mode.
  currentInstall = install;
  throttleBuckets.clear();
  maxEventsPerIssuePerMinute = DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;
}
