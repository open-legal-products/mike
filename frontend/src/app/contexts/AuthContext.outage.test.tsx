// Live recording of PR #793 (2026-11-05): with GoTrue down, a full page
// reload answered /auth/session with 503 upstream_unavailable, the context
// left the user null, the app layout sent a working session to /login, and
// the login page showed "Couldn't check your session" twice (the toast
// raised before the redirect, and the page's own warning). This drives the
// real AuthProvider and the real auth client against a mocked fetch.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@mike/ui";
import { AuthProvider, useAuth } from "./AuthContext";

const reporting = vi.hoisted(() => ({
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));
vi.mock("@/app/lib/errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/errorReporting")>()),
    ...reporting,
}));

const user = {
    id: "user-1",
    email: "lawyer@example.test",
    pendingEmail: null,
    createdWithGoogle: false,
};

function upstreamUnavailable(): Response {
    return new Response(
        JSON.stringify({
            code: "upstream_unavailable",
            detail: "The server is temporarily unreachable. Please try again shortly.",
            request_id: "req-outage",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
    );
}

function signedIn(): Response {
    return new Response(JSON.stringify({ user }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function Consumer() {
    const { user: currentUser, authLoading } = useAuth();
    return (
        <>
            <span data-testid="user">{currentUser?.email ?? "signed-out"}</span>
            <span data-testid="loading">{String(authLoading)}</span>
        </>
    );
}

const fetchMock = vi.fn();
const sessionCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/session")
        .length;

async function flush() {
    // Let the mocked fetch, the JSON body and React's state updates settle.
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}

describe("AuthProvider during an auth outage", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clearToasts();
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        window.history.pushState({}, "", "/projects");
    });
    afterEach(() => {
        clearToasts();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        window.history.pushState({}, "", "/");
    });

    it("keeps the session unknown, shows one notice and retries until the server answers", async () => {
        fetchMock
            .mockResolvedValueOnce(upstreamUnavailable())
            .mockResolvedValueOnce(upstreamUnavailable())
            .mockResolvedValueOnce(signedIn());

        render(
            <AuthProvider>
                <Consumer />
                <ToastViewportUI />
            </AuthProvider>,
        );
        await flush();

        // Not signed out: still loading, so the app layout keeps its loader
        // up instead of redirecting to /login.
        expect(sessionCalls()).toBe(1);
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
        expect(screen.getAllByText(/Couldn't check your session/)).toHaveLength(1);

        // First retry after 1 s fails again: still one notice.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        await flush();
        expect(sessionCalls()).toBe(2);
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
        expect(screen.getAllByText(/Couldn't check your session/)).toHaveLength(1);

        // Second retry backs off to 2 s and finds the session.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_999);
        });
        expect(sessionCalls()).toBe(2);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        await flush();
        expect(sessionCalls()).toBe(3);
        expect(screen.getByTestId("user")).toHaveTextContent(user.email);
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        expect(screen.queryAllByText(/Couldn't check your session/)).toHaveLength(0);

        // Recovered: no further retries.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(sessionCalls()).toBe(3);
        // The first failure goes to reportApiFailure, which only marks an
        // upstream_unavailable the backend already reported; the retries are
        // marked handled without it.
        expect(reporting.reportApiFailure).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ code: "upstream_unavailable" }),
        );
    });

    it("still treats a 401 as signed out, without retrying", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ detail: "Invalid or expired session" }), {
                status: 401,
                headers: { "content-type": "application/json" },
            }),
        );

        render(
            <AuthProvider>
                <Consumer />
                <ToastViewportUI />
            </AuthProvider>,
        );
        await flush();

        expect(screen.getByTestId("user")).toHaveTextContent("signed-out");
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        expect(screen.queryAllByText(/Couldn't check your session/)).toHaveLength(0);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(sessionCalls()).toBe(1);
    });

    function internalError(): Response {
        return new Response(
            JSON.stringify({
                code: "internal_error",
                detail: "Something went wrong. Please try again.",
                request_id: "req-500",
            }),
            { status: 500, headers: { "content-type": "application/json" } },
        );
    }

    async function advance(ms: number) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ms);
        });
        await flush();
    }

    it("reports a persistent 500 once and does not retry it", async () => {
        fetchMock.mockImplementation(async () => internalError());

        render(
            <AuthProvider>
                <Consumer />
                <ToastViewportUI />
            </AuthProvider>,
        );
        await flush();
        await advance(10 * 60_000);

        // A retry cannot fix a bug: one request, one report, loader down.
        expect(sessionCalls()).toBe(1);
        expect(reporting.reportApiFailure).toHaveBeenCalledOnce();
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
        expect(screen.getAllByText(/Couldn't check your session/)).toHaveLength(1);
    });

    it("does not retry a schema_out_of_date 503", async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({ code: "schema_out_of_date", detail: "x" }),
                    { status: 503, headers: { "content-type": "application/json" } },
                ),
        );

        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await flush();
        await advance(10 * 60_000);

        expect(sessionCalls()).toBe(1);
        expect(screen.getByTestId("loading")).toHaveTextContent("false");
    });

    it("reports a proxy outage once per streak, not once per retry", async () => {
        // A non-JSON 502 from a proxy: no code the server side reported.
        fetchMock.mockImplementation(
            async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
        );

        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await flush();
        await advance(5 * 60_000);

        expect(sessionCalls()).toBeGreaterThan(5);
        expect(reporting.reportApiFailure).toHaveBeenCalledOnce();
        expect(screen.getByTestId("loading")).toHaveTextContent("true");
    });

    it("keeps one retry chain when focus events arrive during an outage", async () => {
        // Each answer takes half a second, so a focus event can land while a
        // retry's request is still in flight.
        fetchMock.mockImplementation(
            () =>
                new Promise<Response>((resolve) =>
                    setTimeout(() => resolve(upstreamUnavailable()), 500),
                ),
        );

        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await flush();
        // For two minutes, focus the window right after each retry starts.
        let seen = sessionCalls();
        for (let elapsed = 0; elapsed < 2 * 60_000; elapsed += 100) {
            await advance(100);
            if (sessionCalls() > seen) {
                act(() => {
                    window.dispatchEvent(new Event("focus"));
                });
                seen = sessionCalls();
            }
        }

        // Then five quiet minutes: one chain at the 30 s cap makes about ten
        // calls; every chain orphaned by a focus adds its own.
        const beforeQuiet = sessionCalls();
        await advance(5 * 60_000);
        expect(sessionCalls() - beforeQuiet).toBeLessThanOrEqual(11);
    });

    it("stops checking after the provider unmounts mid-request", async () => {
        fetchMock.mockImplementation(
            () =>
                new Promise<Response>((resolve) =>
                    setTimeout(() => resolve(upstreamUnavailable()), 1_000),
                ),
        );

        const view = render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await flush();
        expect(sessionCalls()).toBe(1);
        view.unmount();
        await advance(10 * 60_000);

        expect(sessionCalls()).toBe(1);
    });

    it("dismisses the session notice when a focus check recovers after retries", async () => {
        fetchMock
            .mockResolvedValueOnce(signedIn())
            .mockResolvedValueOnce(upstreamUnavailable())
            .mockResolvedValueOnce(signedIn());

        render(
            <AuthProvider>
                <Consumer />
                <ToastViewportUI />
            </AuthProvider>,
        );
        await flush();
        expect(screen.getByTestId("user")).toHaveTextContent(user.email);

        act(() => {
            window.dispatchEvent(new Event("focus"));
        });
        await flush();
        expect(screen.getAllByText(/Couldn't check your session/)).toHaveLength(1);

        // The retry finds the same user: the notice goes with the outage.
        await advance(1_000);
        expect(sessionCalls()).toBe(3);
        expect(screen.getByTestId("user")).toHaveTextContent(user.email);
        expect(screen.queryAllByText(/Couldn't check your session/)).toHaveLength(0);
    });
});
