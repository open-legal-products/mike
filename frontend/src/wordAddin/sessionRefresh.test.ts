/**
 * The Word add-in's 401 handling, exercised from the frontend test runner.
 *
 * Fail-without-fix: `fetchWithRefresh` used to do
 * `refreshSession().catch(() => null)` and then `notifySessionExpired()` for
 * every falsy result, so a dropped Wi-Fi link told the user their session had
 * expired (it had not), left the pane signed in with no login gate to click,
 * and never re-ran the request that a SUCCESSFUL refresh had just fixed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    classifySessionRefresh,
    createRefreshingFetch,
} from "../../../word-addin/src/taskpane/lib/sessionRefresh";

class StatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
    }
}

function setOnline(online: boolean): void {
    Object.defineProperty(navigator, "onLine", {
        value: online,
        configurable: true,
    });
}

afterEach(() => {
    setOnline(true);
    vi.restoreAllMocks();
});

describe("classifySessionRefresh", () => {
    it("treats a returned user as a live session", () => {
        expect(classifySessionRefresh({ ok: true, user: { id: "u1" } })).toEqual(
            { kind: "refreshed" },
        );
    });

    it("treats a null user as the backend saying the session is gone", () => {
        // requestSession() returns null specifically on a 401 from
        // /auth/session — that is a verdict, not a guess.
        expect(classifySessionRefresh({ ok: true, user: null })).toEqual({
            kind: "expired",
        });
    });

    it("treats a transport failure as unknown, NOT as an expired session", () => {
        const error = new TypeError("Load failed");
        expect(classifySessionRefresh({ ok: false, error })).toEqual({
            kind: "unreachable",
        });
    });

    it("treats an offline device as unknown", () => {
        setOnline(false);
        expect(
            classifySessionRefresh({ ok: false, error: new Error("nope") }),
        ).toEqual({ kind: "unreachable" });
    });

    it("treats a timeout as unknown", () => {
        const timeout = new Error("timed out");
        timeout.name = "TimeoutError";
        expect(classifySessionRefresh({ ok: false, error: timeout })).toEqual({
            kind: "unreachable",
        });
    });

    it("treats a thrown 401 or 403 as a real expiry", () => {
        expect(
            classifySessionRefresh({ ok: false, error: new StatusError(401) }),
        ).toEqual({ kind: "expired" });
        expect(
            classifySessionRefresh({ ok: false, error: new StatusError(403) }),
        ).toEqual({ kind: "expired" });
    });

    it("does not call a 5xx on the refresh endpoint an expired session", () => {
        // The server failed to answer the question; it did not answer "no".
        expect(
            classifySessionRefresh({ ok: false, error: new StatusError(500) }),
        ).toEqual({ kind: "unreachable" });
    });
});

describe("createRefreshingFetch", () => {
    const ok = (): Response => new Response("{}", { status: 200 });
    const unauthorized = (): Response => new Response("", { status: 401 });

    it("passes a non-401 straight through without refreshing", async () => {
        const refreshSession = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValue(ok());
        const fetchWithRefresh = createRefreshingFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            refreshSession,
            onExpired: vi.fn(),
            onUnreachable: vi.fn(),
        });

        const response = await fetchWithRefresh("/api/workflows");

        expect(response.status).toBe(200);
        expect(refreshSession).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("re-runs the original request once after a successful refresh", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(unauthorized())
            .mockResolvedValueOnce(ok());
        const onExpired = vi.fn();
        const onUnreachable = vi.fn();
        const fetchWithRefresh = createRefreshingFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            refreshSession: vi.fn().mockResolvedValue({ id: "u1" }),
            onExpired,
            onUnreachable,
        });

        const response = await fetchWithRefresh("/api/workflows", {
            method: "POST",
            body: JSON.stringify({ a: 1 }),
        });

        // Without the retry the caller was handed the stale 401 and showed a
        // permission error for a session that had just been renewed.
        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/workflows");
        expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
            method: "POST",
            credentials: "include",
            body: JSON.stringify({ a: 1 }),
        });
        expect(onExpired).not.toHaveBeenCalled();
        expect(onUnreachable).not.toHaveBeenCalled();
    });

    it("retries exactly once, never looping on a backend that 401s everything", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(unauthorized());
        const fetchWithRefresh = createRefreshingFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            refreshSession: vi.fn().mockResolvedValue({ id: "u1" }),
            onExpired: vi.fn(),
            onUnreachable: vi.fn(),
        });

        const response = await fetchWithRefresh("/api/workflows");

        expect(response.status).toBe(401);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("signs the pane out when the refresh says the session is gone", async () => {
        const onExpired = vi.fn();
        const onUnreachable = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValue(unauthorized());
        const fetchWithRefresh = createRefreshingFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            refreshSession: vi.fn().mockResolvedValue(null),
            onExpired,
            onUnreachable,
        });

        const response = await fetchWithRefresh("/api/workflows");

        expect(response.status).toBe(401);
        expect(onExpired).toHaveBeenCalledTimes(1);
        expect(onUnreachable).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a network failure as an unchecked session, not an expired one", async () => {
        const onExpired = vi.fn();
        const onUnreachable = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValue(unauthorized());
        const fetchWithRefresh = createRefreshingFetch({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            refreshSession: vi
                .fn()
                .mockRejectedValue(new TypeError("Load failed")),
            onExpired,
            onUnreachable,
        });

        const response = await fetchWithRefresh("/api/workflows");

        expect(response.status).toBe(401);
        // The bug this replaces: onExpired fired here, telling the user to
        // sign in while the pane stayed signed in.
        expect(onExpired).not.toHaveBeenCalled();
        expect(onUnreachable).toHaveBeenCalledTimes(1);
    });
});
