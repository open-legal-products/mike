import { beforeEach, describe, expect, it, vi } from "vitest";

const { guardedFetch, validateRemoteMcpUrl, extractPdfTextForModel } = vi.hoisted(() => ({
    guardedFetch: vi.fn(),
    validateRemoteMcpUrl: vi.fn(),
    extractPdfTextForModel: vi.fn(),
}));

vi.mock("../../mcp/client", () => ({ guardedFetch, validateRemoteMcpUrl }));
vi.mock("../../pdfText", () => ({ extractPdfTextForModel }));

import { BlockedDestinationError } from "../../blockedDestination";
import { WebPageUnreadableError, readWebPage } from "../pageReader";

const ARTICLE = `<!doctype html>
<html>
<head><title>Section 172 duties | Example Law</title></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main>
<article>
<h1>Section 172 duties</h1>
<p>A director must act in the way they consider, in good faith, would be most likely to promote the success of the company for the benefit of its members as a whole.</p>
<p>See the <a href="https://www.legislation.gov.uk/ukpga/2006/46/section/172">statutory text</a> for the full list of factors.</p>
</article>
</main>
<footer>Copyright Example Law</footer>
</body>
</html>`;

const page = (body: BodyInit, contentType: string) =>
    new Response(body, { headers: { "content-type": contentType } });

async function unreadable(promise: Promise<unknown>): Promise<string> {
    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WebPageUnreadableError);
    return (error as Error).message;
}

beforeEach(() => {
    guardedFetch.mockReset();
    validateRemoteMcpUrl.mockReset();
    validateRemoteMcpUrl.mockImplementation(async (url: string) => url);
    vi.unstubAllGlobals();
});

describe("readWebPage", () => {
    it("returns an HTML page's article as markdown, without the page chrome", async () => {
        guardedFetch.mockResolvedValue(page(ARTICLE, "text/html; charset=utf-8"));

        const result = await readWebPage("https://example.test/s172");

        expect(result.title).toContain("Section 172 duties");
        expect(result.text).toContain("promote the success of the company");
        expect(result.text).toContain(
            "[statutory text](https://www.legislation.gov.uk/ukpga/2006/46/section/172)",
        );
        expect(result.text).not.toContain("Copyright Example Law");
    });

    it("decodes text in the charset the server declares", async () => {
        guardedFetch.mockResolvedValue(
            page(
                new Uint8Array([0xa7, 0x31, 0x37, 0x32, 0x20, 0x43, 0x61, 0x66, 0xe9]),
                'text/plain; charset="ISO-8859-1"',
            ),
        );

        const result = await readWebPage("https://example.test/s172.txt");

        expect(result.text).toBe("\u00a7172 Caf\u00e9");
    });

    it.each([
        ['<meta charset="iso-8859-1">'],
        ['<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'],
    ])("decodes HTML in the charset its %s declares", async (meta) => {
        const html = `<html><head>${meta}<title>Act</title></head><body><article><p>Section \u00a7172 applies to the Caf\u00e9 Company.</p></article></body></html>`;
        guardedFetch.mockResolvedValue(
            page(Uint8Array.from(html, (c) => c.charCodeAt(0)), "text/html"),
        );

        const result = await readWebPage("https://example.test/act");

        expect(result.text).toContain("Section \u00a7172 applies to the Caf\u00e9 Company.");
    });

    it("decodes as UTF-8 when the declared charset is unknown", async () => {
        guardedFetch.mockResolvedValue(page("caf\u00e9", "text/plain; charset=bogus"));

        const result = await readWebPage("https://example.test/cafe.txt");

        expect(result.text).toBe("caf\u00e9");
    });

    it("reads a PDF served as a generic binary file", async () => {
        guardedFetch.mockResolvedValue(
            page("%PDF-1.7 ...", "application/octet-stream"),
        );
        extractPdfTextForModel.mockResolvedValue("Order adopting rules.");

        const result = await readWebPage("https://files.example.test/filing");

        expect(result.text).toBe("Order adopting rules.");
    });

    it("refuses file types it cannot read", async () => {
        guardedFetch.mockResolvedValue(page("zip", "application/zip"));

        await expect(unreadable(readWebPage("https://example.test/a.zip"))).resolves.toBe(
            "This kind of file cannot be read as a web page.",
        );
    });

    it.each([
        [
            "tavily",
            { results: [{ url: "https://law.test/ca2006", raw_content: "# Companies Act 2006" }] },
            null,
        ],
        [
            "deepseek",
            { title: "Companies Act 2006", content: "# Companies Act 2006" },
            "Companies Act 2006",
        ],
    ] as const)("reads the page through %s when it can", async (backend, body, title) => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));

        const result = await readWebPage("https://law.test/ca2006", {
            account: { backend, apiKey: "key" },
        });

        expect(result).toEqual({
            url: "https://law.test/ca2006",
            title,
            text: "# Companies Act 2006",
        });
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("reads a page the search service could not", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
        guardedFetch.mockResolvedValue(page("The order.", "text/plain"));

        const result = await readWebPage("https://law.test/order.txt", {
            account: { backend: "deepseek", apiKey: "key" },
        });

        expect(result.text).toBe("The order.");
    });

    it("does not send a private address to the search service", async () => {
        const fetch = vi.fn(async () => Response.json({ content: "secret" }));
        vi.stubGlobal("fetch", fetch);
        validateRemoteMcpUrl.mockRejectedValue(
            new BlockedDestinationError("Web page URL resolves to a blocked network address."),
        );

        await expect(
            unreadable(
                readWebPage("http://169.254.169.254/latest/meta-data/", {
                    account: { backend: "tavily", apiKey: "key" },
                }),
            ),
        ).resolves.toBe("That address is not a public web page.");
        expect(fetch).not.toHaveBeenCalled();
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("explains a blocked address", async () => {
        guardedFetch.mockRejectedValue(
            new BlockedDestinationError("Web page URL resolves to a blocked network address."),
        );

        await expect(unreadable(readWebPage("http://10.0.0.1/"))).resolves.toBe(
            "That address is not a public web page.",
        );
    });
});
