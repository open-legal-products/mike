import { describe, expect, it } from "vitest";
import {
    CONSOLE_CAPTURE_MECHANISM,
    type ScrubbableEvent,
    createEventScrubber,
    normalizeApiPath,
    parseSampleRate,
    redactSensitiveValues,
    redactUrl,
    releaseName,
    redactText,
    MIKE_SENTRY_DSN,
    installKind,
    redactFilesystemPaths,
    repoRelativePath,
    resolveDsn,
} from "./sentryEvent";

describe("redactSensitiveValues", () => {
    it("filters secret-looking keys at any depth and leaves the rest", () => {
        expect(
            redactSensitiveValues({
                note: "keep",
                Authorization: "Bearer x",
                nested: { apiKey: "k", list: [{ refresh_token: "t", n: 1 }] },
            }),
        ).toEqual({
            note: "keep",
            Authorization: "[Filtered]",
            nested: { apiKey: "[Filtered]", list: [{ refresh_token: "[Filtered]", n: 1 }] },
        });
    });

    it("stops descending past the depth cap instead of recursing forever", () => {
        const deep = { a: { b: { c: { d: { e: { f: { g: { h: "x" } } } } } } } };
        expect(JSON.stringify(redactSensitiveValues(deep))).toContain("[Truncated]");
    });

    it("passes primitives through", () => {
        expect(redactSensitiveValues("s")).toBe("s");
        expect(redactSensitiveValues(null)).toBeNull();
    });
});

describe("createEventScrubber", () => {
    it("strips request bodies, cookies, credential headers, and user details", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const event = scrubEvent({
            request: {
                data: "privileged body",
                cookies: { s: "1" },
                headers: { Cookie: "s=1", AUTHORIZATION: "b", accept: "*/*" },
            },
            user: { id: "u1", email: "e@example.com" } as { id: string },
            extra: { password: "p", fine: true },
            contexts: { app: { api_key: "k" } },
            breadcrumbs: [{ data: { token: "t", url: "/x" } }, { message: "m" } as { data?: undefined }],
        })!;
        expect(event.request).toEqual({ headers: { accept: "*/*" } });
        expect(event.user).toEqual({ id: "u1" });
        // extra is allowlisted: "fine" is not a key this codebase attaches,
        // so it is dropped whatever it holds.
        expect(event.extra).toEqual({ password: "[Filtered]", fine: "[Filtered]" });
        expect(event.contexts).toEqual({ app: { api_key: "[Filtered]" } });
        expect(event.breadcrumbs).toEqual([
            { data: { token: "[Filtered]", url: "/x" } },
            { message: "m" },
        ]);
    });

    it("drops a user without an id entirely", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        expect(scrubEvent({ user: {} })!.user).toBeUndefined();
    });

    it("classifies an event without optional sections as a message", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        expect(scrubEvent({})).toEqual({ tags: { capture_source: "message" } });
    });

    it("discards the console bridge's copy of an already-reported error only", () => {
        const { markReported, scrubEvent } = createEventScrubber({ install: "official" });
        const reported = new Error("reported");
        markReported(reported);
        markReported("not an object");
        const consoleEvent = () => ({
            exception: { values: [{ mechanism: { type: CONSOLE_CAPTURE_MECHANISM } }] },
        });

        expect(scrubEvent(consoleEvent(), { originalException: reported })).toBeNull();
        expect(
            scrubEvent(consoleEvent(), { originalException: new Error("fresh") }),
        ).not.toBeNull();
        expect(scrubEvent(consoleEvent(), { originalException: "string" })).not.toBeNull();
        expect(scrubEvent(consoleEvent())).not.toBeNull();
        // A direct capture of the same error is never a duplicate.
        expect(
            scrubEvent(
                { exception: { values: [{ mechanism: { type: "generic" } }] } },
                { originalException: reported },
            ),
        ).not.toBeNull();
    });
});

describe("per-issue flood control", () => {
    const exceptionEvent = (value: string, component = "x"): ScrubbableEvent => ({
        exception: { values: [{ type: "Error", value }] },
        tags: { component },
    });

    it("passes the first N events of an issue per minute and drops the rest", () => {
        let clock = 1_000;
        const { scrubEvent } = createEventScrubber({
            install: "official",
            maxEventsPerIssuePerMinute: 2,
            now: () => clock,
        });
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop"))).toBeNull();
        // Other issues keep their own budget.
        expect(scrubEvent(exceptionEvent("other"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop", "y"))).not.toBeNull();
        expect(scrubEvent({ message: "plain" })).not.toBeNull();
        // Window rollover.
        clock += 60_000;
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
    });

    it("keys on the fingerprint when present", () => {
        const { scrubEvent } = createEventScrubber({ install: "official", maxEventsPerIssuePerMinute: 1 });
        expect(
            scrubEvent({ fingerprint: ["api-5xx"], message: "a" }),
        ).not.toBeNull();
        expect(scrubEvent({ fingerprint: ["api-5xx"], message: "b" })).toBeNull();
    });

    it("defaults to ten per minute", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        for (let i = 0; i < 10; i += 1) {
            expect(scrubEvent(exceptionEvent("ten"))).not.toBeNull();
        }
        expect(scrubEvent(exceptionEvent("ten"))).toBeNull();
    });
});

describe("console bridge post-processing", () => {
    const consoleHint = (args: unknown[]) => ({
        captureContext: { extra: { arguments: args } },
    });

    it("drops a console message whose logged object wraps a reported error", () => {
        const { markReported, scrubEvent } = createEventScrubber({ install: "official" });
        const error = new Error("nested");
        markReported(error);
        expect(
            scrubEvent(
                { logger: "console", message: "[x] failed [object Object]" },
                consoleHint(["[x] failed", { id: 1, error }]),
            ),
        ).toBeNull();
    });

    it("retitles a message around an unreported nested error and groups by label", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const error = new RangeError("too deep");
        const event: ScrubbableEvent = {
            logger: "console",
            message: "[x] failed [object Object]",
            extra: {},
        };
        const scrubbed = scrubEvent(event, consoleHint(["[x] failed", { cause: { error } }]))!;
        expect(scrubbed.message).toBe("[x] failed: RangeError: too deep");
        expect(scrubbed.fingerprint).toEqual(["console", "[x] failed", "RangeError"]);
        expect(scrubbed.extra?.error_stack).toContain("RangeError: too deep");
    });

    it("preserves an exception event when the error is a top-level argument", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const scrubbed = scrubEvent(
            { logger: "console", message: "kept", exception: { values: [{ value: "top" }] } },
            consoleHint(["label", new Error("top")]),
        )!;
        expect(scrubbed.message).toBe("kept");
    });

    it("ignores non-console events and malformed hints", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        expect(
            scrubEvent({ message: "m" }, consoleHint([{ error: new Error("x") }]))!
                .message,
        ).toBe("m");
        expect(
            scrubEvent(
                { logger: "console", message: "m" },
                { captureContext: { extra: { arguments: "nope" } } },
            )!.message,
        ).toBe("m");
        expect(
            scrubEvent({ logger: "console", message: "m" }, { captureContext: null })!
                .message,
        ).toBe("m");
        expect(
            scrubEvent({ logger: "console", message: "m" }, consoleHint(["a", 1, null]))!
                .message,
        ).toBe("a");
    });

    it("stops searching past two levels of nesting", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const scrubbed = scrubEvent(
            { logger: "console", message: "m" },
            consoleHint([{ a: { b: { c: new Error("deep") } } }]),
        )!;
        expect(scrubbed.message).toBe("Console error");
    });
});

describe("normalizeApiPath", () => {
    it("uses a pathname for absolute endpoints and scrubs download credentials", () => {
        expect(normalizeApiPath("https://internal.firm.example/api/projects/123?key=x#fragment"))
            .toBe("/api/projects/:id");
        expect(normalizeApiPath("https://internal.firm.example")).toBe("/");
        expect(normalizeApiPath("/download/private-download-token")).toBe("/download/[Filtered]");
    });
    it("replaces uuids and numeric segments and drops the query string", () => {
        expect(
            normalizeApiPath(
                "/projects/8f1c2a3e-1234-4bcd-9e0f-1234567890ab/documents/42?x=1",
            ),
        ).toBe("/projects/:id/documents/:id");
        expect(normalizeApiPath("/user/profile")).toBe("/user/profile");
    });
});

describe("parseSampleRate", () => {
    it("clamps to [0, 1] and falls back on junk", () => {
        expect(parseSampleRate(undefined, 0.2)).toBe(0.2);
        expect(parseSampleRate("abc", 0.2)).toBe(0.2);
        expect(parseSampleRate("5", 0)).toBe(1);
        expect(parseSampleRate("-1", 0)).toBe(0);
        expect(parseSampleRate("0.5", 0)).toBe(0.5);
    });
});

describe("redactUrl", () => {
    it("filters the download token segment and credential-looking query params", () => {
        expect(redactUrl("/api/download/tok-123?inline=1")).toBe(
            "/api/download/[Filtered]?inline=1",
        );
        expect(
            redactUrl("/api/user/oauth/callback?code=AUTH&state=S&provider=google"),
        ).toBe("/api/user/oauth/callback?code=[Filtered]&state=[Filtered]&provider=google");
        expect(redactUrl("/api/projects/1/documents?limit=20")).toBe(
            "/api/projects/1/documents?limit=20",
        );
    });
});

describe("scrubEvent URL hygiene", () => {
    it("redacts request url, query string, url-shaped extras and breadcrumb urls", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const out = scrubEvent({
            request: {
                url: "https://app.local/api/download/tok?x=1",
                query_string: "code=AUTH&x=1",
            },
            extra: { path: "/api/download/tok" },
            breadcrumbs: [
                {
                    data: {
                        url: "https://s3.local/b/k?X-Amz-Signature=sig&X-Amz-Expires=60",
                    },
                },
            ],
        })!;
        expect(out.request?.url).toBe("https://app.local/api/download/[Filtered]?x=1");
        expect(out.request?.query_string).toBe("code=[Filtered]&x=1");
        expect(out.extra?.path).toBe("/api/download/[Filtered]");
        expect(out.breadcrumbs?.[0]?.data?.url).toBe(
            "https://s3.local/b/k?X-Amz-Signature=[Filtered]&X-Amz-Expires=60",
        );
    });
});

describe("query parameter forms", () => {
    it("filters credential keys whether the SDK sends a string, a map, or pairs", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const asMap = scrubEvent({ request: { query_string: { code: "A", page: "2" } } })!;
        expect(asMap.request?.query_string).toEqual({ code: "[Filtered]", page: "2" });
        const asPairs = scrubEvent({
            request: { query_string: [["token", "T"], ["page", "2"], ["odd"], [1, "x"]] },
        })!;
        expect(asPairs.request?.query_string).toEqual([
            ["token", "[Filtered]"],
            ["page", "2"],
            ["odd"],
            [1, "x"],
        ]);
        const other = scrubEvent({ request: { query_string: 42 } })!;
        expect(other.request?.query_string).toBe(42);
    });

    it("still filters a key whose percent-encoding is malformed", () => {
        expect(redactUrl("/x?%E0token=abc&ok=1")).toBe("/x?%E0token=[Filtered]&ok=1");
        expect(redactUrl("/x?flag&token=abc")).toBe("/x?flag&token=[Filtered]");
    });
});

describe("releaseName", () => {
    it("prefers an explicit release, falls back to the git sha, else undefined", () => {
        expect(releaseName("mike@1.4.0", "abcdef1234567890")).toBe("mike@1.4.0");
        expect(releaseName("  ", "abcdef1234567890abcd")).toBe("mike@abcdef123456");
        expect(releaseName(undefined, undefined)).toBeUndefined();
        expect(releaseName("", "")).toBeUndefined();
    });
});

describe("value-level redaction (due-diligence findings)", () => {
    const SECRETS = [
        "sk-ant-api03-abcdefghijklmnop",
        "Bearer eyJhbGciOi.secret.sig",
        "eyJhbGciOi.secret.sig",
        "jane.doe@bigfirm.com",
        "X-Amz-Signature=deadbeef",
        "AKIAABCDEFGHIJKLMNOP",
        "PRIVILEGED settlement",
    ];

    it("leaves none of a key, a bearer token, a JWT, an email, a signed URL, or a stray document field anywhere on the event", () => {
        const event = {
            message: "Bearer eyJhbGciOi.secret.sig for jane.doe@bigfirm.com",
            exception: {
                values: [
                    {
                        type: "Error",
                        value:
                            'duplicate key value violates unique constraint "profiles_email_key" DETAIL: Key (email)=(jane.doe@bigfirm.com) already exists. key sk-ant-api03-abcdefghijklmnop',
                    },
                ],
            },
            extra: {
                presigned:
                    "https://s3.example/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP",
                doc_text: "PRIVILEGED settlement $4.2m",
                job_id: "j1",
                detail: "user jane.doe@bigfirm.com hit AKIAABCDEFGHIJKLMNOP",
                arguments: ["[x] failed", { documentId: "d1", note: "PRIVILEGED settlement" }],
            },
            contexts: { app: { note: "sk-ant-api03-abcdefghijklmnop" } },
            breadcrumbs: [
                {
                    message: "user jane.doe@bigfirm.com Bearer eyJhbGciOi.secret.sig",
                    data: { url: "https://x/?token=1", free: "PRIVILEGED settlement" },
                },
            ],
        };

        const out = JSON.stringify(createEventScrubber({ install: "official" }).scrubEvent(event, {}));

        for (const secret of SECRETS) expect(out).not.toContain(secret);
        // What must survive: the shape of the failure and the ids to find it.
        expect(out).toContain('"job_id":"j1"');
        expect(out).not.toContain('"documentId":"d1"'); // raw console payloads are excluded
        expect(out).toContain("profiles_email_key");
        expect(out).toContain("[email]");
    });

    it("redactText handles each secret class on its own", () => {
        expect(redactText("key sk-ant-api03-abcdefghijklmnop here")).toBe("key [api-key] here");
        expect(redactText("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [Filtered]");
        expect(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBe("jwt [jwt]");
        expect(redactText("mail a.b+c@d.co and https://s3/x?X-Amz-Signature=1&X-Amz-Expires=60")).toBe(
            "mail [email] and https://s3/x?X-Amz-Signature=[Filtered]&X-Amz-Expires=60",
        );
        expect(redactText("plain message with nothing in it")).toBe("plain message with nothing in it");
    });
});

describe("automatic captures of an already-reported error", () => {
    it("drops the global handler's copy (handled: false) but keeps the explicit capture", () => {
        const { markReported, scrubEvent } = createEventScrubber({ install: "official" });
        const failure = new Error("API 502");
        markReported(failure);

        const unhandled = {
            exception: {
                values: [{ mechanism: { type: "onunhandledrejection", handled: false } }],
            },
        };
        expect(scrubEvent(unhandled, { originalException: failure })).toBeNull();
        expect(
            scrubEvent(
                { exception: { values: [{ mechanism: { type: "generic", handled: true } }] } },
                { originalException: failure },
            ),
        ).not.toBeNull();
        expect(
            scrubEvent(unhandled, { originalException: new Error("other") }),
        ).not.toBeNull();
    });
});

describe("resolveDsn", () => {
    it("is off when disabled, uses an explicit DSN, else the built-in Mike DSN", () => {
        expect(resolveDsn({ disabled: "true", dsn: "https://x@y/1", fallback: MIKE_SENTRY_DSN.frontend })).toEqual({ dsn: "", source: "disabled" });
        expect(resolveDsn({ disabled: "TRUE ", fallback: "f" })).toEqual({ dsn: "", source: "disabled" });
        expect(resolveDsn({ disabled: "false", dsn: " https://x@y/1 ", fallback: "f" })).toEqual({ dsn: "https://x@y/1", source: "env" });
        expect(resolveDsn({ dsn: "", fallback: MIKE_SENTRY_DSN.wordAddin })).toEqual({ dsn: MIKE_SENTRY_DSN.wordAddin, source: "default" });
    });

    it("only an explicit 'official' marks the official deployment", () => {
        expect(installKind("official")).toBe("official");
        expect(installKind(" Official ")).toBe("official");
        expect(installKind(undefined)).toBe("community");
        expect(installKind("")).toBe("community");
        expect(installKind("yes")).toBe("community");
    });
});

describe("community install minimisation", () => {
    it("removes deployment URLs from tags, extras, grouping keys and error text", () => {
        const url = "https://internal.firm.example/api/projects";
        const out = createEventScrubber().scrubEvent({
            message: `Failed to fetch ${url}`,
            exception: { values: [{ value: `Failed to fetch ${url}` }] },
            tags: { http_route: url, component: "mike-api" },
            extra: { url, path: url, error_stack: `fetch ${url}` },
            fingerprint: ["api-network", "GET", url],
        })!;
        expect(JSON.stringify(out)).not.toContain("internal.firm.example");
        expect(out.tags.http_route).toBe("/api/projects");
        expect(out.extra.url).toBe("/api/projects");
        expect(out.fingerprint).toEqual(["api-network", "GET", "/api/projects"]);
    });

    it.each(["community", "official"] as const)("scrubs tags and fingerprints for %s installs", (install) => {
        const out = createEventScrubber({ install }).scrubEvent({
            tags: { detail: "person@example.test", api_key: "private-key" },
            fingerprint: ["person@example.test", "Bearer private-token"],
        })!;
        expect(out.tags).toEqual({ detail: "[email]", api_key: "[Filtered]", capture_source: "message" });
        expect(out.fingerprint).toEqual(["[email]", "Bearer [Filtered]"]);
    });

    it.each(["community", "official"] as const)("drops raw bodies and positional console data for %s installs", (install) => {
        const args = ["[model] failed", "SYNTHETIC_PRIVATE_CLAUSE", { body: "SYNTHETIC_PRIVATE_CLAUSE" }];
        const out = createEventScrubber({ install }).scrubEvent({
            logger: "console",
            message: "[model] failed SYNTHETIC_PRIVATE_CLAUSE",
            extra: { arguments: args, body: "SYNTHETIC_PRIVATE_CLAUSE", documentId: "d1" },
        }, { captureContext: { extra: { arguments: args } } })!;
        expect(JSON.stringify(out)).not.toContain("SYNTHETIC_PRIVATE_CLAUSE");
        expect(out.message).toBe("[model] failed");
        expect(out.extra.documentId).toBe("d1");
    });
    it("relativises code locations and redacts filesystem paths in text", () => {
        expect(repoRelativePath("/Users/jane/work/mike/backend/src/lib/x.ts")).toBe("backend/src/lib/x.ts");
        expect(repoRelativePath("/app/frontend/src/app/page.tsx")).toBe("frontend/src/app/page.tsx");
        expect(repoRelativePath("/srv/mike/node_modules/react/index.js")).toBe("node_modules/react/index.js");
        expect(repoRelativePath("https://firm.example/_next/static/chunks/main.js")).toBe("/_next/static/chunks/main.js");
        expect(repoRelativePath("/opt/other/tool.js")).toBe("[external]");
        expect(redactFilesystemPaths("read /home/u/mike/backend/src/a.ts then /var/lib/x")).toBe("read backend/src/a.ts then [path]");
        expect(redactFilesystemPaths("C:\\Users\\bob\\file.txt failed")).toBe("[path] failed");
    });

    it("is the default for createEventScrubber and strips machine, user, headers, breadcrumbs, and narrow contexts", () => {
        const { scrubEvent } = createEventScrubber();
        const out = scrubEvent({
            server_name: "janes-macbook.local",
            user: { id: "user-1" },
            breadcrumbs: [{ message: "user clicked" }],
            tags: { component: "mike-api", server_name: "janes-macbook.local" },
            request: { url: "https://firm.example/api/projects/1", method: "POST", headers: { host: "firm.example" } },
            contexts: {
                browser: { name: "Chrome", version: "128" },
                device: { screen_resolution: "1440x900" },
                culture: { timezone: "Europe/Berlin" },
            },
            exception: {
                values: [{ value: "boom", stacktrace: { frames: [{ filename: "/Users/jane/mike/frontend/src/app/x.tsx", in_app: true }] } }],
            },
        })!;
        expect(out.server_name).toBeUndefined();
        expect(out.user).toBeUndefined();
        expect(out.breadcrumbs).toBeUndefined();
        expect(out.tags).toEqual({ component: "mike-api", capture_source: "exception" });
        expect(out.request).toEqual({ method: "POST", url: "/api/projects/1" });
        expect(out.contexts).toEqual({ browser: { name: "Chrome", version: "128" } });
        expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe("frontend/src/app/x.tsx");
        expect(JSON.stringify(out)).not.toMatch(/jane|firm\.example|Berlin/);
    });

    it("keeps the full shape for the official install", () => {
        const { scrubEvent } = createEventScrubber({ install: "official" });
        const out = scrubEvent({ server_name: "web-1", user: { id: "u" }, breadcrumbs: [{ message: "m" }] })!;
        expect(out.server_name).toBe("web-1");
        expect(out.user).toEqual({ id: "u" });
        expect(out.breadcrumbs).toHaveLength(1);
    });
});
