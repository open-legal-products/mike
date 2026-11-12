import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

// CourtListener requests go out through the shared SSRF guard (guardedFetch),
// which resolves the host and then sends with undici's own fetch. Both are
// faked here so no test touches the network.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: lookupMock } }));
vi.mock("undici", async (importOriginal) => {
    const actual = await importOriginal<typeof import("undici")>();
    return { ...actual, fetch: vi.fn() };
});

import { getCourtlistenerCaseOpinions } from "../courtlistener";

const TOKEN = "test-token";
const transport = vi.mocked(undiciFetch);
// The unguarded global fetch must never be used for CourtListener traffic.
const globalFetch = vi.fn(async () => {
    throw new Error("unguarded global fetch called");
});

function resolvesTo(address: string) {
    lookupMock.mockResolvedValue([{ address, family: 4 }]);
}

function page(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function requestedUrls(): string[] {
    return [...transport.mock.calls, ...globalFetch.mock.calls].map(
        (call) => String((call as unknown[])[0]),
    );
}

beforeEach(() => {
    lookupMock.mockReset();
    transport.mockReset();
    globalFetch.mockClear();
    vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("CourtListener egress", () => {
    it("sends an ordinary request through the guarded transport with the token", async () => {
        resolvesTo("93.184.216.34");
        transport.mockResolvedValueOnce(
            page({ results: [{ id: 7, plain_text: "Opinion text." }], next: null }) as never,
        );

        const result = await getCourtlistenerCaseOpinions({
            clusterId: 1,
            apiToken: TOKEN,
        });

        expect(result).toMatchObject({ id: 1, source: "api" });
        expect(transport).toHaveBeenCalledTimes(1);
        const [url, init] = transport.mock.calls[0] as unknown as [
            string,
            { headers: Record<string, string>; dispatcher: unknown },
        ];
        expect(url).toBe(
            "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=1",
        );
        expect(new Headers(init.headers).get("authorization")).toBe(
            `Token ${TOKEN}`,
        );
        expect(init.dispatcher).toBeInstanceOf(Agent);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it("refuses to connect when CourtListener's host resolves to a private address", async () => {
        resolvesTo("10.0.0.5");

        await expect(
            getCourtlistenerCaseOpinions({ clusterId: 1, apiToken: TOKEN }),
        ).rejects.toThrow("CourtListener URL resolves to a blocked network address.");
        expect(requestedUrls()).toEqual([]);
    });

    it("does not send the token to a pagination link on another host", async () => {
        resolvesTo("93.184.216.34");
        transport.mockResolvedValueOnce(
            page({
                results: [],
                next: "https://cl-mirror.example.net/api/rest/v4/opinions/?cursor=x",
            }) as never,
        );

        await expect(
            getCourtlistenerCaseOpinions({ clusterId: 1, apiToken: TOKEN }),
        ).rejects.toThrow("CourtListener returned a link outside its API.");
        expect(requestedUrls()).toEqual([
            "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=1",
        ]);
    });
});
