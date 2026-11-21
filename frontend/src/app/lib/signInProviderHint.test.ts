import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSignInProviderHint } from "./signInProviderHint";

const fetchMock = vi.fn();

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("API_BASE_URL", "https://backend.example.test/base/");
});

afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("readSignInProviderHint", () => {
    it("reads the providers from the API, cached rather than per request", async () => {
        fetchMock.mockResolvedValue(
            Response.json({ google: true, sso: false, setupRequired: true, signup: false }),
        );

        // Only the two provider flags: a stale setup or sign-up answer
        // would redirect, so those stay with the browser's own check.
        await expect(readSignInProviderHint()).resolves.toEqual({ google: true, sso: false });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { next?: unknown }];
        expect(url).toBe("https://backend.example.test/base/auth/options");
        // A per-request (`no-store`) read would turn the static sign-in
        // pages into dynamic ones that wait on the API.
        expect(init.next).toEqual({ revalidate: 60 });
        expect(init.cache).toBeUndefined();
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
        ["the API answers with an error", () => fetchMock.mockResolvedValue(new Response(null, { status: 503 }))],
        ["the API is unreachable", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
        ["the answer is not the expected shape", () => fetchMock.mockResolvedValue(Response.json({ google: "yes" }))],
        ["the answer is not JSON", () => fetchMock.mockResolvedValue(new Response("<html>"))],
    ])("has no hint when %s", async (_name, arrange) => {
        arrange();
        await expect(readSignInProviderHint()).resolves.toBeNull();
    });

    it("has no hint, and asks nothing, when a production build has no API configured", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("API_BASE_URL", "");
        await expect(readSignInProviderHint()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
