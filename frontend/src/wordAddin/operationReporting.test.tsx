/**
 * What the Word add-in's user-visible failures carry to Sentry: the
 * `operation` naming the flow, the component, Word's own code or the
 * server's code and request id — and when a failure shown to the user is
 * NOT sent (a 4xx, a cancellation, a fault some other layer already filed).
 * Exercised from the frontend runner through the add-in's `@mike/*` aliases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeScope = {
    setLevel: ReturnType<typeof vi.fn>;
    setTag: ReturnType<typeof vi.fn>;
    setExtra: ReturnType<typeof vi.fn>;
    setFingerprint: ReturnType<typeof vi.fn>;
};

const state = vi.hoisted(() => ({
    enabled: true,
    scopes: [] as FakeScope[],
}));

vi.mock("@sentry/react", () => ({
    isEnabled: () => state.enabled,
    init: vi.fn(),
    captureException: vi.fn(() => "exc-1"),
    captureMessage: vi.fn(() => "msg-1"),
    setUser: vi.fn(),
    getCurrentScope: vi.fn(),
    captureConsoleIntegration: vi.fn(() => ({ name: "CaptureConsole" })),
    ErrorBoundary: () => null,
    withScope: (cb: (scope: FakeScope) => unknown) => {
        const scope: FakeScope = {
            setLevel: vi.fn(),
            setTag: vi.fn(),
            setExtra: vi.fn(),
            setFingerprint: vi.fn(),
        };
        state.scopes.push(scope);
        return cb(scope);
    },
}));

import * as Sentry from "@sentry/react";
import { diagnosticEvent } from "@mike/client";
import { clearToasts } from "@mike/client";
import { UserVisibleError } from "@mike/client";
import {
    isReported,
    reportApiFailure,
    reportError,
    reportHostlessOfficeClient,
    reportNetworkFailure,
    reportWordFailure,
} from "../../../word-addin/src/taskpane/lib/errorReporting";
import { configureMikeApiClient, MikeApiError, updateWorkflow } from "../../../word-addin/src/taskpane/api/client";
import {
    notifyError,
    reportFault,
    userMessage,
} from "../../../word-addin/src/taskpane/lib/notify";
import { refreshSession } from "../../../word-addin/src/taskpane/auth/session";

/** The tags one capture set, as `{ name: value }`. */
function tagsOf(scope: FakeScope | undefined): Record<string, unknown> {
    return Object.fromEntries(
        (scope?.setTag.mock.calls ?? []) as Array<[string, unknown]>,
    );
}

beforeEach(() => {
    clearToasts();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    clearToasts();
    state.scopes.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("the add-in's operations", () => {
    it("are all values the privacy boundary keeps", () => {
        expect(diagnosticEvent({ tags: { operation: "word.new_operation" } }).tags)
            .toEqual({ operation: "word.new_operation" });
    });
});

// Review of #789: the pane shows a static notice when Office.onReady has no
// host. A crawler (MIKE-WORD-ADDIN-6/7) has no Office diagnostics and must
// stay silent; a real Office client misdetected as hostless must not.
describe("reportHostlessOfficeClient", () => {
    it("sends nothing for a plain browser tab, which has no Office diagnostics", () => {
        vi.stubGlobal("Office", { context: {} });
        reportHostlessOfficeClient();
        vi.stubGlobal("Office", undefined);
        reportHostlessOfficeClient();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("sends one warning when an Office client reports diagnostics but no host", () => {
        vi.stubGlobal("Office", {
            context: { diagnostics: { host: null, platform: "Mac", version: "16.99" } },
        });
        reportHostlessOfficeClient();
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
            "office host null inside an Office client",
            {
                level: "warning",
                tags: { operation: "office.on_ready", error_kind: "office_host_null" },
            },
        );
    });
});

describe("reportWordFailure", () => {
    it("names the operation beside the stage and Word's code", () => {
        const refused = Object.assign(new Error("refused"), { code: "GeneralException" });
        reportWordFailure(refused, { stage: "resolve", operation: "word.edit_resolve" });
        expect(Sentry.captureException).toHaveBeenCalledWith(refused);
        expect(tagsOf(state.scopes[0])).toEqual({
            component: "word-office",
            operation: "word.edit_resolve",
            stage: "resolve",
            office_code: "GeneralException",
        });
        expect(isReported(refused)).toBe(true);
    });

    it("groups an apply failure by its operation when no stage name fits", () => {
        const refused = Object.assign(new Error("refused"), { code: "InvalidArgument" });
        reportWordFailure(refused, { operation: "word.edit_apply" });
        const scope = state.scopes[0]!;
        expect(tagsOf(scope)).toEqual({
            component: "word-office",
            operation: "word.edit_apply",
            office_code: "InvalidArgument",
        });
        expect(scope.setFingerprint).toHaveBeenCalledWith([
            "word-office",
            "word.edit_apply",
            "InvalidArgument",
        ]);
    });
});

describe("API and transport reports", () => {
    it("carry the operation the request belonged to", () => {
        const failed = new MikeApiError({ status: 500, message: "x", requestId: "r-1" });
        reportApiFailure({
            path: "/auth/session",
            method: "GET",
            status: 500,
            code: "internal_error",
            requestId: "r-1",
            operation: "word.session",
            error: failed,
        });
        expect(tagsOf(state.scopes[0])).toMatchObject({
            component: "mike-api",
            operation: "word.session",
            http_status: 500,
            error_code: "internal_error",
            request_id: "r-1",
        });
        expect(isReported(failed)).toBe(true);

        const dead = new TypeError("Load failed");
        reportNetworkFailure(dead, { method: "POST", url: "/api/auth/login", operation: "word.session" });
        expect(tagsOf(state.scopes[1])).toMatchObject({
            component: "mike-api",
            operation: "word.session",
            network: true,
        });
        expect(isReported(dead)).toBe(true);
    });

    it.each(["upstream_unavailable", "schema_out_of_date"])(
        "leave a %s answer to the server, which already filed it once",
        (code) => {
            // The backend files a GoTrue outage once per process (tagged
            // operation=auth.session, fingerprint upstream-unavailable) and a
            // missing migration once per key; the gateway files a backend
            // outage. A pane copy per request would be a second issue for the
            // same incident.
            const failed = new MikeApiError({ status: 503, code, message: "x", requestId: "r-2" });
            expect(
                reportApiFailure({
                    path: "/auth/session",
                    method: "GET",
                    status: 503,
                    code,
                    requestId: "r-2",
                    operation: "word.session",
                    error: failed,
                    reportingOwner: "backend",
                }),
            ).toBeNull();
            expect(Sentry.captureException).not.toHaveBeenCalled();
            expect(Sentry.captureMessage).not.toHaveBeenCalled();
            expect(state.scopes).toHaveLength(0);
            // Marked, so a later notice of the same error stays quiet too.
            expect(isReported(failed)).toBe(true);
        },
    );
});

describe("what a notice reports", () => {
    it("files a throw it could not classify under the flow it broke", () => {
        const bug = new TypeError("cannot read properties of undefined");
        notifyError(bug, { action: "load your workflows", operation: "workflows.run" });
        expect(Sentry.captureException).toHaveBeenCalledWith(bug);
        expect(tagsOf(state.scopes[0])).toEqual({
            component: "notify",
            operation: "workflows.run",
        });
    });

    it("carries the server's code and request id on a 5xx nobody filed", () => {
        const failed = new MikeApiError({
            status: 500,
            code: "internal_error",
            message: "x",
            requestId: "req-9",
        });
        notifyError(failed, { operation: "quick_actions.run" });
        expect(tagsOf(state.scopes[0])).toEqual({
            component: "notify",
            operation: "quick_actions.run",
            error_code: "internal_error",
            request_id: "req-9",
        });
    });

    it("does not file a fault twice, nor a rephrasing of one", () => {
        const filed = new Error("already captured");
        reportError(filed, { tags: { component: "word-chat" } });
        notifyError(filed, { operation: "word_chat.turn" });
        // The failed turn is rephrased as "outcome unknown" with the real
        // failure as its cause; that wrapper is the same incident.
        notifyError(new UserVisibleError("The outcome is unknown.", { cause: filed }), {
            operation: "word_chat.turn",
        });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it("stays quiet for failures that are not faults", () => {
        // An intentional 4xx answer.
        notifyError(new MikeApiError({ status: 400, message: "Bad." }), { operation: "workflows.run" });
        // The transport, which the API client reports under mike-api itself.
        notifyError(new TypeError("Failed to fetch"), { operation: "workflows.run" });
        // A cancellation the user caused.
        notifyError(new DOMException("x", "AbortError"), { operation: "workflows.run" });
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
});

describe("userMessage", () => {
    it("reports a fault only when the screen names the flow", () => {
        const bug = new Error("boom");
        expect(userMessage(bug, { fallback: "Mike couldn't open this chat." })).toBe(
            "Mike couldn't open this chat.",
        );
        expect(Sentry.captureException).not.toHaveBeenCalled();

        reportFault(bug, { fallback: "Mike couldn't open this chat.", operation: "word_chat.turn" });
        expect(Sentry.captureException).toHaveBeenCalledWith(bug);
        expect(tagsOf(state.scopes[0])).toEqual({ component: "notify", operation: "word_chat.turn" });
        // Shown a second time (the card and its persisted copy): one event.
        reportFault(bug, { fallback: "x", operation: "word_chat.turn" });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it("reportFault files a swallowed fault under its flow", () => {
        reportFault(new Error("unparseable session body"), { operation: "word.session" });
        expect(tagsOf(state.scopes[0])).toEqual({ component: "notify", operation: "word.session" });
        reportFault(new MikeApiError({ status: 401, message: "no" }), { operation: "word.session" });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
});

describe("the session refresh", () => {
    function answer(status: number, body: string, headers: Record<string, string> = {}): Response {
        return new Response(body, { status, headers });
    }

    it("files a 5xx from /auth/session under word.session with its request id", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => answer(502, "<html>bad gateway</html>", { "x-request-id": "req-5" })),
        );
        await expect(refreshSession()).rejects.toMatchObject({ status: 502 });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(tagsOf(state.scopes[0])).toMatchObject({
            component: "mike-api",
            operation: "word.session",
            http_status: 502,
            request_id: "req-5",
        });
        // The 5xx is filed once: the refresh's own fault check sees it was.
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("files an unreachable backend as a word.session transport failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
        await expect(refreshSession()).rejects.toMatchObject({ kind: "network" });
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(tagsOf(state.scopes[0])).toMatchObject({
            component: "mike-api",
            operation: "word.session",
            network: true,
            http_method: "GET",
        });
    });

    it("files an answer it cannot read, which the 401 handler would otherwise swallow", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => answer(200, "not json")));
        await expect(refreshSession()).rejects.toBeInstanceOf(SyntaxError);
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(tagsOf(state.scopes[0])).toEqual({ component: "notify", operation: "word.session" });
    });

    it("says nothing about a 401, which is an answer", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => answer(401, "{}")));
        await expect(refreshSession()).resolves.toBeNull();
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
});


describe("workflow API failure identity", () => {
    it.each([false, true])("captures the API operation before a delayed screen handler (wrapped: %s)", async wrapped => {
        vi.useFakeTimers();
        try {
            configureMikeApiClient({
                baseUrl: "https://api.example.test",
                getAuthHeaders: async () => ({}),
                fetchImpl: async () => new Response(JSON.stringify({ code: "internal_error" }), {
                    status: 500, headers: { "x-request-id": "req-workflow" },
                }),
            });
            const error = await updateWorkflow("11111111-2222-4333-8444-555555555555", { skill_md: "# Workflow" })
                .catch((error: unknown) => error);
            expect(error).toBeInstanceOf(MikeApiError);
            expect(Sentry.captureException).toHaveBeenCalledTimes(1);
            expect(tagsOf(state.scopes[0]).operation).toBe("workflows.run");
            await vi.advanceTimersByTimeAsync(1000);
            const shown = wrapped ? new UserVisibleError("The outcome is unknown.", { cause: error }) : error;
            reportFault(shown, { operation: "workflows.run" });
            notifyError(error, { operation: "workflows.run" });
            await vi.runAllTimersAsync();
            expect(Sentry.captureException).toHaveBeenCalledTimes(1);
            expect(Sentry.captureMessage).not.toHaveBeenCalled();
            expect(tagsOf(state.scopes[0])).toMatchObject({
                component: "mike-api", operation: "workflows.run", http_status: 500,
                http_method: "PATCH", http_route: "/workflows/:id", request_id: "req-workflow",
                error_code: "internal_error",
            });
        } finally {
            vi.useRealTimers();
        }
    });
});


it("sends immediately without a screen and suppresses a later notice", async () => {
    vi.useFakeTimers();
    try {
        const error = new MikeApiError({ status: 500, message: "Failed" });
        reportApiFailure({ path: "/workflows", status: 500, error });
        expect(isReported(error)).toBe(true);
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        notifyError(error, { operation: "workflows.run" });
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    } finally {
        vi.useRealTimers();
    }
});

it("reports an unowned 503 even with a recognized code, preserving the original Error", () => {
    const failure = new Error("private transport detail");
    reportApiFailure({ path: "/chat", status: 503, code: "upstream_unavailable", error: failure });
    expect(Sentry.captureException).toHaveBeenCalledWith(failure);
});
