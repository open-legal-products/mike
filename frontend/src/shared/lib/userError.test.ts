import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GENERIC_FAILURE_MESSAGE,
    SUPPORT_EMAIL,
    UserVisibleError,
    buildSupportMailto,
    describeError,
    isNetworkError,
} from "./userError";

class FakeApiError extends Error {
    status: number;
    code: string | null;
    requestId: string | null;
    constructor(args: {
        message: string;
        status: number;
        code?: string | null;
        requestId?: string | null;
    }) {
        super(args.message);
        this.status = args.status;
        this.code = args.code ?? null;
        this.requestId = args.requestId ?? null;
    }
}

describe("describeError", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", { onLine: true, userAgent: "vitest" });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps the backend's 4xx detail because it is written for users", () => {
        const described = describeError(
            new FakeApiError({
                status: 400,
                message: "Password must be at most 72 characters.",
                code: "weak_password",
                requestId: "req-1",
            }),
            { action: "update your password" },
        );
        expect(described).toMatchObject({
            kind: "validation",
            title: "Couldn't update your password",
            message: "Password must be at most 72 characters.",
            retryable: false,
            supportable: false,
            status: 400,
            code: "weak_password",
            requestId: "req-1",
        });
    });

    it("never echoes a 5xx body and offers retry plus support", () => {
        const described = describeError(
            new FakeApiError({
                status: 500,
                message: "TypeError: Cannot read properties of undefined",
                code: "internal_error",
                requestId: "req-500",
            }),
        );
        expect(described.kind).toBe("server");
        expect(described.message).not.toMatch(/TypeError/);
        expect(described.message).toMatch(/Try again/);
        expect(described.retryable).toBe(true);
        expect(described.supportable).toBe(true);
        expect(described.requestId).toBe("req-500");
    });

    it("classifies a fetch TypeError as a network problem", () => {
        const described = describeError(new TypeError("Failed to fetch"), {
            action: "load documents",
        });
        expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
        expect(described.kind).toBe("network");
        expect(described.title).toBe("Couldn't load documents");
        expect(described.message).toMatch(/Check your connection/);
        expect(described.retryable).toBe(true);
    });

    it("reports offline before network when the browser says so", () => {
        vi.stubGlobal("navigator", { onLine: false, userAgent: "vitest" });
        const described = describeError(new TypeError("Failed to fetch"));
        expect(described.kind).toBe("offline");
        expect(described.message).toMatch(/offline/i);
    });

    it("does not call an ordinary TypeError a network error", () => {
        const described = describeError(
            new TypeError("Cannot read properties of null"),
        );
        expect(described.kind).toBe("unknown");
        expect(described.message).toBe(GENERIC_FAILURE_MESSAGE);
        expect(described.message).not.toMatch(/null/);
    });

    it("treats an aborted request as cancelled and not retryable", () => {
        const abort = new DOMException("The user aborted", "AbortError");
        const described = describeError(abort);
        expect(described.kind).toBe("aborted");
        expect(described.retryable).toBe(false);
        expect(described.supportable).toBe(false);
    });

    it.each([
        [401, "unauthenticated", /session has expired/i],
        [403, "forbidden", /permission/i],
        [404, "not_found", /no longer exists/i],
        [409, "conflict", /changed somewhere else/i],
        [413, "payload_too_large", /too large/i],
        [429, "rate_limited", /Too many requests/i],
        [503, "unavailable", /temporarily unavailable/i],
        [504, "timeout", /took too long/i],
    ] as const)(
        "maps HTTP %i with a bare status message to %s",
        (status, kind, pattern) => {
            const described = describeError(
                new FakeApiError({ status, message: `API error: ${status}` }),
            );
            expect(described.kind).toBe(kind);
            expect(described.message).toMatch(pattern);
            expect(described.message).not.toMatch(/API error/);
        },
    );

    it("lets a backend code override the status mapping", () => {
        const described = describeError(
            new FakeApiError({
                status: 400,
                code: "rate_limited",
                message: "Slow down.",
            }),
        );
        expect(described.kind).toBe("rate_limited");
        expect(described.retryable).toBe(true);
        // The backend's own wording still wins for a 4xx.
        expect(described.message).toBe("Slow down.");
    });

    it("prefers a call-site codeMessages entry over everything", () => {
        const described = describeError(
            new FakeApiError({
                status: 409,
                code: "name_taken",
                message: "duplicate key value violates unique constraint",
            }),
            { codeMessages: { name_taken: "A project with that name already exists." } },
        );
        expect(described.message).toBe(
            "A project with that name already exists.",
        );
    });

    it("shows a UserVisibleError verbatim and honours its retry flag", () => {
        const described = describeError(
            new UserVisibleError("Pick at least one file.", {
                kind: "validation",
                retryable: false,
            }),
        );
        expect(described.message).toBe("Pick at least one file.");
        expect(described.kind).toBe("validation");
        expect(described.retryable).toBe(false);
    });

    it("keeps a network UserVisibleError's own wording", () => {
        // The Word add-in names the server origin in its transport failures
        // ("...couldn't reach the server at http://localhost:3001"), which a
        // self-hoster needs. That only survives because an explicit
        // `kind: "network"` is classified without the message being replaced
        // by the generic line below.
        const described = describeError(
            new UserVisibleError(
                "Mike couldn't reach the server at http://localhost:3001.",
                { kind: "network", retryable: true },
            ),
        );
        expect(described.message).toBe(
            "Mike couldn't reach the server at http://localhost:3001.",
        );
        expect(described.kind).toBe("network");
        expect(described.retryable).toBe(true);
        expect(described.supportable).toBe(false);
    });

    it("replaces the message of anything named NetworkError", () => {
        // The counterpart of the rule above, and the reason the add-in's
        // transport error does NOT take that name: this path classifies by
        // name and always substitutes its own copy.
        const error = new Error("Load failed at http://localhost:3001");
        error.name = "NetworkError";
        const described = describeError(error);
        expect(described.kind).toBe("network");
        expect(described.message).not.toContain("Load failed");
    });

    it("uses the fallback only for unclassifiable failures", () => {
        expect(
            describeError(new Error("boom"), { fallback: "Couldn't load chats." })
                .message,
        ).toBe("Couldn't load chats.");
        expect(
            describeError(new FakeApiError({ status: 500, message: "x" }), {
                fallback: "Couldn't load chats.",
            }).message,
        ).not.toBe("Couldn't load chats.");
    });

    it("handles non-error throwables without crashing", () => {
        for (const value of [null, undefined, "string", 42, {}]) {
            const described = describeError(value);
            expect(described.kind).toBe("unknown");
            expect(described.message).toBe(GENERIC_FAILURE_MESSAGE);
        }
    });

    it("reads request ids from snake_case bodies as well", () => {
        const described = describeError({
            status: 500,
            message: "internal",
            request_id: "abc",
        });
        expect(described.requestId).toBe("abc");
    });
});

describe("buildSupportMailto", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", { onLine: true, userAgent: "TestBrowser/1" });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("addresses support and carries the diagnostic fields", () => {
        const href = buildSupportMailto(
            {
                title: "Couldn't save the document",
                message: "Something went wrong on our side. Try again.",
                kind: "server",
                status: 500,
                code: "internal_error",
                requestId: "req-42",
            },
            {
                page: "https://app.mikeoss.com/projects/1",
                product: "web",
                when: new Date("2026-09-17T10:00:00Z"),
            },
        );
        expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
        const url = new URL(href);
        const params = new URLSearchParams(url.search);
        expect(params.get("subject")).toBe(
            "Mike support: Couldn't save the document",
        );
        const body = params.get("body") ?? "";
        expect(body).toContain("Request ID: req-42");
        expect(body).toContain("Error code: internal_error");
        expect(body).toContain("HTTP status: 500");
        expect(body).toContain("Page: https://app.mikeoss.com/projects/1");
        expect(body).toContain("Client: web");
        expect(body).toContain("Time: 2026-09-17T10:00:00.000Z");
        expect(body).toContain("Browser: TestBrowser/1");
        expect(href).not.toContain("+");
    });

    it("omits unknown fields instead of writing null", () => {
        const href = buildSupportMailto({
            title: "Connection problem",
            message: "m",
            kind: "network",
            status: null,
            code: null,
            requestId: null,
        });
        const body = new URLSearchParams(new URL(href).search).get("body") ?? "";
        expect(body).not.toMatch(/null|undefined/);
        expect(body).not.toContain("Request ID");
        expect(body).not.toContain("HTTP status");
    });
});

describe("support URL privacy", () => {
    it("omits query strings, fragments, and URL credentials", () => {
        const href = buildSupportMailto(describeError(new Error("internal")), {
            page: "https://user:password@app.example/auth/callback?code=secret#access_token=hidden",
        });
        const body = new URL(href).searchParams.get("body");
        expect(body).toContain("Page: https://app.example/auth/callback");
        expect(body).not.toMatch(/secret|hidden|password|user@/);
    });
});
