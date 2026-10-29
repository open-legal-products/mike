import { describe, expect, it, vi } from "vitest";

import { createWebSearch } from "../search";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

const BRAVE_RESULTS = {
    web: {
        results: [
            {
                url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172",
                title: "Companies Act 2006, s 172 &amp; s 174",
                description: "Duty to promote the &quot;success&quot; of the company.",
                extra_snippets: ["A director&#x27;s duty..."],
            },
            { url: "javascript:alert(1)", title: "Not a page" },
        ],
    },
};

const brave = { account: { backend: "brave", apiKey: "brave-key" } } as const;

function harness(responses: Response[]) {
    const fetch = vi.fn(async (_url: unknown, _init?: unknown) => responses.shift()!);
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const search = createWebSearch({ fetch: fetch as never, now: () => 1_000_000, sleep });
    return { search, fetch, sleep };
}

describe("Mike's web search", () => {
    it("needs a key", async () => {
        const { search, fetch } = harness([]);

        await expect(search("s172", { account: null })).rejects.toMatchObject({
            code: "not_configured",
            // The kind Sentry files it under, carried by the error itself.
            kind: "web_search.not_configured",
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("searches Brave with its key, keeps only web pages and decodes entities", async () => {
        const { search, fetch } = harness([json(BRAVE_RESULTS)]);

        const results = await search("directors duties s172", brave);

        expect(results).toEqual([
            {
                url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172",
                title: "Companies Act 2006, s 172 & s 174",
                snippet:
                    "Duty to promote the \"success\" of the company. … A director's duty...",
            },
        ]);
        const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toContain("https://api.search.brave.com/res/v1/web/search");
        expect(url.searchParams.get("q")).toBe("directors duties s172");
        expect(init.headers).toMatchObject({ "x-subscription-token": "brave-key" });
        expect(init.redirect).toBe("manual");
    });

    it.each([
        ["tavily", { results: [{ url: "https://law.test/a", title: "Act A", content: "About A." }] }],
        [
            "deepseek",
            {
                results: [
                    { url: "https://law.test/a", title: "Act A", snippet: "A.", summary: "About A." },
                ],
            },
        ],
    ] as const)("searches %s with a bearer key", async (backend, body) => {
        const { search, fetch } = harness([json(body)]);

        const results = await search("act a", { account: { backend, apiKey: "key" } });

        expect(results).toEqual([
            { url: "https://law.test/a", title: "Act A", snippet: "About A." },
        ]);
        const [, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({ authorization: "Bearer key" });
        expect(JSON.parse(String(init.body))).toMatchObject({ query: "act a" });
    });

    it.each([
        ["brave", 401, "rejected"],
        ["brave", 422, "rejected"],
        ["brave", 429, "failed"],
        ["tavily", 432, "rejected"],
        ["deepseek", 402, "rejected"],
    ] as const)("reports %s HTTP %s as %s", async (backend, status, code) => {
        const { search } = harness([json({}, status)]);

        await expect(
            search("q", { account: { backend, apiKey: "key" } }),
        ).rejects.toMatchObject({
            code,
            kind: `web_search.${code}`,
            // The API's status rides on the cause as dependency_status.
            cause: { kind: "web_search.api_error", status },
        });
    });

    it("spaces out parallel requests made with the same key", async () => {
        const { search, fetch, sleep } = harness([
            json(BRAVE_RESULTS),
            json(BRAVE_RESULTS),
        ]);
        const signal = new AbortController().signal;

        await Promise.all([
            search("one", brave),
            search("two", { ...brave, signal }),
        ]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledWith(1_100, signal);
    });
});
