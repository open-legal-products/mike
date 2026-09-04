import { afterEach, describe, expect, it, vi } from "vitest";
import {
    authenticatedFetch,
    AUTH_SESSION_INVALIDATED_EVENT,
} from "./authEvents";

describe("authenticatedFetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("always includes cookies and invalidates auth after a 401", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 401 }));
        const listener = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

        await authenticatedFetch("/api/projects", { credentials: "omit" });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/projects",
            expect.objectContaining({ credentials: "include" }),
        );
        expect(listener).toHaveBeenCalledTimes(1);
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });

    it("does not invalidate auth for an OAuth-required connector response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        code: "oauth_required",
                        detail: "OAuth authorization is required.",
                    }),
                    {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    },
                ),
            ),
        );
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

        const response = await authenticatedFetch(
            "/api/user/mcp-connectors/connector-id/tools/refresh",
        );

        expect(response.status).toBe(401);
        expect(listener).not.toHaveBeenCalled();
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });

    it("does not invalidate auth for successful responses", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        );
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);

        await authenticatedFetch("/api/projects");

        expect(listener).not.toHaveBeenCalled();
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });
});
