import { diagnosticErrorTags } from "./sentryPrivacy";

/**
 * Sentry event hygiene shared by the web app (browser + Next server) and the
 * Word add-in. Framework-free on purpose: this file must not import from
 * `@/app/` (the add-in bundles it through a webpack alias) and it must not
 * import a Sentry package either, because the two targets use different
 * ones (`@sentry/nextjs` vs `@sentry/react`) — the structural types below
 * are the subset both agree on.
 *
 * Two jobs:
 *
 *  1. SCRUB. Mike handles privileged legal documents. An event may carry a
 *     user id and a route; it must never carry a request body, a cookie, an
 *     auth header, or anything under a key that looks like a secret.
 *  2. DEDUPE. Every remaining `console.error` is bridged into Sentry so no
 *     failure is silently dropped, but code that already reported an error
 *     explicitly (with tags) logs it too. The explicit path marks the error
 *     object; the bridge's copy of a marked error is discarded.
 */

export const CONSOLE_CAPTURE_MECHANISM = "auto.core.capture_console";
export { privacyBoundaryIntegration } from "./sentryPrivacy";

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
    /^(url|href|path|http_route|query_string|referer|referrer|location|redirect(_uri)?)$/i;

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
  * contract clause has no telltale name. Raw console arguments and bodies
  * are always excluded, including strings that have no secret-shaped keys.
  * Attach diagnostic ids explicitly instead of copying logged payloads.
  */
const EXTRA_KEY_ALLOWLIST = new Set([
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
    fingerprint?: string[];
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
    // SDK integrations can already supply repository-relative locations.
    if (/^(?:\.\/)?(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\//.test(path)) return path;
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

/** Community reports must not identify a deployment through an embedded URL. */
function redactCommunityText(text: string): string {
    return redactFilesystemPaths(
        redactText(text).replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
            url.replace(/^https?:\/\/[^/?#]+/i, "") || "/",
        ),
    );
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
        event.tags = mapStringLeaves(event.tags, redactCommunityText) as Record<string, unknown>;
    }
    if (event.fingerprint) event.fingerprint = event.fingerprint.map(redactCommunityText);
    if (event.request) {
        const url =
            typeof event.request.url === "string"
                ? redactCommunityText(event.request.url)
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
        event.message = redactCommunityText(event.message);
    }
    for (const value of event.exception?.values ?? []) {
        if (typeof value.value === "string") {
            value.value = redactCommunityText(value.value);
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
        event.extra = mapStringLeaves(event.extra, redactCommunityText) as Record<
            string,
            unknown
        >;
    }
    return event;
}
// END shared-redaction

/** The pieces of a Sentry event this module reads or rewrites. */
// No index signatures: the SDKs' `ErrorEvent` is an interface, and an
// interface is not assignable to an indexable type, so the shape below must
// name only the properties it touches.
export type ScrubbableEvent = {
    /** Set to "console" by the console bridge on every event it creates. */
    logger?: string;
    message?: string;
    server_name?: string;
    fingerprint?: string[];
    tags?: Record<string, unknown>;
    exception?: {
        values?: {
            type?: string;
            value?: string;
            mechanism?: { type?: string; handled?: boolean };
            stacktrace?: {
                frames?: {
                    filename?: string;
                    abs_path?: string;
                    in_app?: boolean;
                }[];
            };
        }[];
    };
    request?: {
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string>;
        url?: string;
        method?: string;
        query_string?: unknown;
    };
    user?: { id?: string | number };
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
};

export type ScrubHint = {
    originalException?: unknown;
    /**
     * The console bridge passes its raw `console.error` arguments here
     * (`{ extra: { arguments } }`); by the time `beforeSend` runs the copy on
     * the event has been normalised, so this is the only place the original
     * objects can still be recognised.
     */
    captureContext?: unknown;
};

const NESTED_SEARCH_DEPTH = 2;

function consoleArguments(hint: ScrubHint): unknown[] | null {
    const context = hint.captureContext as
        | { extra?: { arguments?: unknown } }
        | undefined;
    const args = context?.extra?.arguments;
    return Array.isArray(args) ? args : null;
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

/** Kept for callers and tests: SDK-shaped redaction. */
export const redactSensitiveValues = redactShaped;

const DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;

function issueKey(event: ScrubbableEvent): string {
    if (event.fingerprint?.length) return event.fingerprint.join("|");
    const exception = event.exception?.values?.[0];
    const base = exception
        ? `${exception.type ?? "Error"}: ${exception.value ?? ""}`
        : (event.message ?? "");
    const component = (event.tags as Record<string, unknown> | undefined)
        ?.component;
    return `${component ?? ""}::${base.slice(0, 300)}`;
}

/**
 * A registry of errors already sent with explicit context, plus per-issue
 * flood control. Each runtime (web app, add-in) creates one and installs its
 * scrubber as `beforeSend`.
 *
 * Flood control: a render loop or a retry loop can raise the same error many
 * times a second, and Sentry only collapses strictly consecutive duplicates.
 * The first `maxEventsPerIssuePerMinute` events of an issue go out; the rest
 * are dropped locally so the quota stays for the next, different bug.
 */
export function createEventScrubber(options?: {
    maxEventsPerIssuePerMinute?: number;
    now?: () => number;
    /** Community installs get the minimised shape; default, the safe side. */
    install?: InstallKind;
}) {
    const install = options?.install ?? "community";
    const reported = new WeakSet<object>();
    const budget =
        options?.maxEventsPerIssuePerMinute ??
        DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;
    const now = options?.now ?? (() => Date.now());
    const buckets = new Map<string, { windowStart: number; sent: number }>();

    const withinBudget = (event: ScrubbableEvent): boolean => {
        const key = issueKey(event);
        const at = now();
        let bucket = buckets.get(key);
        if (!bucket || at - bucket.windowStart >= THROTTLE_WINDOW_MS) {
            bucket = { windowStart: at, sent: 0 };
            buckets.set(key, bucket);
        }
        if (bucket.sent >= budget) return false;
        bucket.sent += 1;
        return true;
    };

    const markReported = (error: unknown): void => {
        if (error && typeof error === "object") reported.add(error);
    };

    const scrubEvent = <T extends ScrubbableEvent>(
        event: T,
        hint: ScrubHint = {},
    ): T | null => {
        // An error reported explicitly (with tags) must not be filed a second
        // time by an automatic path: the console bridge's copy, or the
        // global unhandled-error/rejection handler's copy when the same
        // object then escapes (a reported 5xx that the caller rethrows).
        // An explicit capture arrives with handled: true (or no mechanism)
        // and is always kept.
        const mechanismInfo = event.exception?.values?.[0]?.mechanism;
        const mechanism = mechanismInfo?.type;
        const automatic =
            mechanism === CONSOLE_CAPTURE_MECHANISM ||
            mechanismInfo?.handled === false;
        const original = hint.originalException;
        if (
            automatic &&
            original &&
            typeof original === "object" &&
            reported.has(original)
        ) {
            return null;
        }

        // console.error("[label] failed", { jobId, error }) — the common shape
        // in this codebase. The bridge only recognises a top-level Error, so
        // it sends this as a message titled "[label] failed [object Object]".
        // Recover: drop it if that nested error was already reported, else
        // give the message the error's name and text and group by label.
        const args =
            event.logger === "console" ? consoleArguments(hint) : null;
        if (args) {
            if (args.some((arg) => findNested(arg, (c) => reported.has(c)))) {
                return null;
            }
            // Only the first argument is the logging label. Other strings
            // may be document/model output; never concatenate them into titles
            // or grouping keys. Raw arguments are removed by scrubFreeform.
            const label = typeof args[0] === "string" ? args[0].trim() : "Console error";
            const nestedError = args
                .map((arg) =>
                    typeof arg === "object" && arg instanceof Error
                        ? null
                        : findNested(arg, (c) => c instanceof Error),
                )
                .find((found): found is Error => found instanceof Error);
            if (nestedError) {
                event.message = `${label ? `${label}: ` : ""}${nestedError.name}: ${nestedError.message}`;
                event.fingerprint = ["console", label, nestedError.name];
                event.extra = {
                    ...(event.extra ?? {}),
                    error_stack: nestedError.stack,
                };
            } else if (!event.exception?.values?.length) {
                event.message = label;
            }
        }

        event.tags = {
            ...event.tags,
            ...diagnosticErrorTags(original),
            capture_source: event.logger === "console" ? "console" : mechanismInfo?.handled === false ? "unhandled" : event.exception?.values?.length ? "exception" : "message",
        };
        for (const arg of args ?? []) {
            const nested = findNested(arg, c => c instanceof Error || 'code' in c);
            Object.assign(event.tags, diagnosticErrorTags(nested));
        }

        // The title and the exception text are free text from libraries
        // that quote emails, tokens, and URLs; key filtering cannot see them.
        if (typeof event.message === "string") {
            event.message = redactText(event.message);
        }
        for (const value of event.exception?.values ?? []) {
            if (typeof value.value === "string") {
                value.value = redactText(value.value);
            }
        }
        if (event.tags) event.tags = redactShaped(event.tags) as Record<string, unknown>;
        if (event.fingerprint) event.fingerprint = event.fingerprint.map(redactText);
        if (event.request) {
            delete event.request.data;
            delete event.request.cookies;
            // The URL stays (it says which endpoint), its credentials do not.
            if (typeof event.request.url === "string") {
                event.request.url = redactUrl(event.request.url);
            }
            if (event.request.query_string !== undefined) {
                event.request.query_string = redactQueryParams(
                    event.request.query_string,
                );
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
            event.user = event.user.id ? { id: event.user.id } : undefined;
        }
        if (event.extra) {
            event.extra = scrubFreeform(event.extra) as Record<string, unknown>;
        }
        if (event.contexts) {
            event.contexts = redactShaped(event.contexts) as Record<
                string,
                unknown
            >;
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
        if (install === "community") minimiseForCommunity(event);
        if (!withinBudget(event)) return null;
        return event;
    };

    return { markReported, scrubEvent };
}

/**
 * Collapse ids out of an API path so one failing endpoint groups as one
 * Sentry issue: /projects/8f1c…/documents/42 → /projects/:id/documents/:id.
 */
export function normalizeApiPath(path: string): string {
    const pathname = path.replace(/^(?:https?:)?\/\/[^/?#]+/i, "").split(/[?#]/)[0] || "/";
    return redactText(redactUrl(pathname))
        .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            ":id",
        )
        .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/** Clamp an env-provided sample rate to [0, 1]; anything unparseable → fallback. */
export function parseSampleRate(
    raw: string | undefined,
    fallback: number,
): number {
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 0), 1);
}

/**
 * The release every event is tagged with. An explicit SENTRY_RELEASE wins;
 * otherwise the git commit the build came from (`mike@<sha12>`), which is
 * what lets Sentry say "regressed in this deploy" and resolve an issue
 * until the next release. Undefined when neither is known (a dev checkout).
 */
export function releaseName(
    explicit: string | undefined,
    gitSha: string | undefined,
): string | undefined {
    const named = explicit?.trim();
    if (named) return named;
    const sha = gitSha?.trim();
    return sha ? `mike@${sha.slice(0, 12)}` : undefined;
}
