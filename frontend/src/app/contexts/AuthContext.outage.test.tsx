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
        // The backend already reported upstream_unavailable.
        expect(reporting.reportApiFailure).not.toHaveBeenCalled();
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
});
