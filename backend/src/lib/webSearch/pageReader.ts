import { isBlockedDestinationError } from "../blockedDestination";
import { guardedFetch, validateRemoteMcpUrl } from "../mcp/client";
import { extractPdfTextForModel } from "../pdfText";
import { withTimeout } from "./http";
import { SEARCH_SERVICES } from "./services";
import type { WebPage, WebSearchAccount } from "./types";

/** A page that could not be read; the message is safe to show the model. */
export class WebPageUnreadableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "WebPageUnreadableError";
    }
}

const REQUEST_HEADERS = {
    "user-agent": "Mozilla/5.0 (compatible; MikeBot/1.0)",
    "accept-language": "en-US,en;q=0.9",
    accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
};

// Pages are parsed on the main thread, so keep them small. Anything that is
// not text may still be a PDF, which needs more room.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

// Some sites serve PDFs as application/octet-stream.
const isPdf = (contentType: string, body: ArrayBuffer) =>
    contentType === "application/pdf" ||
    new TextDecoder().decode(body.slice(0, 5)) === "%PDF-";

const tooLarge = () =>
    new WebPageUnreadableError("The page is too large to read.");

const isText = (contentType: string) =>
    contentType.startsWith("text/") || contentType === "application/xhtml+xml";

async function readCapped(
    response: Response,
    maxBytes: number,
): Promise<ArrayBuffer> {
    if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) return new ArrayBuffer(0);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
        }
        chunks.push(value);
    }
    return new Blob(chunks).arrayBuffer();
}

async function htmlToMarkdown(
    html: string,
    url: string,
): Promise<{ title: string | null; text: string }> {
    const [{ parseHTML }, { Defuddle }] = await Promise.all([
        import("linkedom"),
        import("defuddle/node"),
    ]);
    const { document } = parseHTML(html);
    const page = await Defuddle(document as unknown as Document, url, {
        markdown: true,
    });
    return { title: page.title?.trim() || null, text: page.content ?? "" };
}

// Many HTML pages declare their encoding only in a <meta> tag. Browsers look
// for it in the first 1024 bytes, which are ASCII whatever the encoding.
function metaCharset(body: ArrayBuffer): string | null {
    const head = new TextDecoder("latin1").decode(body.slice(0, 1024));
    return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? null;
}

// Older court and legislation sites still serve windows-1252 or ISO-8859-1,
// where decoding as UTF-8 would corrupt characters such as "§".
function decodeText(body: ArrayBuffer, charset: string | null): string {
    try {
        return new TextDecoder(charset ?? "utf-8").decode(body);
    } catch {
        return new TextDecoder().decode(body);
    }
}

async function fetchPage(url: string, signal: AbortSignal | undefined) {
    try {
        const response = await guardedFetch(
            url,
            {
                headers: REQUEST_HEADERS,
                signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
            },
            { label: "Web page URL", allowHttp: true },
        );
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new WebPageUnreadableError(
                `The page answered with HTTP ${response.status}.`,
            );
        }
        const header = response.headers.get("content-type") ?? "";
        const contentType = header.split(";")[0].trim().toLowerCase();
        return {
            finalUrl: response.url || url,
            contentType,
            charset: /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(header)?.[1] ?? null,
            body: await readCapped(
                response,
                isText(contentType) ? MAX_TEXT_BYTES : MAX_PDF_BYTES,
            ),
        };
    } catch (error) {
        if (signal?.aborted || error instanceof WebPageUnreadableError) {
            throw error;
        }
        if (isBlockedDestinationError(error)) {
            throw new WebPageUnreadableError(
                "That address is not a public web page.",
                { cause: error },
            );
        }
        throw new WebPageUnreadableError("The page could not be reached.", {
            cause: error,
        });
    }
}

async function readDirectly(
    url: string,
    signal: AbortSignal | undefined,
): Promise<WebPage> {
    const { finalUrl, contentType, charset, body } = await fetchPage(url, signal);
    if (isPdf(contentType, body)) {
        return { url: finalUrl, title: null, text: await extractPdfTextForModel(body) };
    }
    if (contentType === "text/html" || contentType === "application/xhtml+xml") {
        return {
            url: finalUrl,
            ...(await htmlToMarkdown(
                decodeText(body, charset ?? metaCharset(body)),
                finalUrl,
            )),
        };
    }
    if (contentType.startsWith("text/")) {
        return { url: finalUrl, title: null, text: decodeText(body, charset) };
    }
    throw new WebPageUnreadableError(
        "This kind of file cannot be read as a web page.",
    );
}

type ReadOptions = {
    signal?: AbortSignal;
    account?: WebSearchAccount | null;
};

async function assertPublicAddress(url: string): Promise<void> {
    try {
        await validateRemoteMcpUrl(url, "Web page URL", { allowHttp: true });
    } catch (error) {
        if (isBlockedDestinationError(error)) {
            throw new WebPageUnreadableError(
                "That address is not a public web page.",
                { cause: error },
            );
        }
        throw new WebPageUnreadableError("The page could not be reached.", {
            cause: error,
        });
    }
}

async function readThroughSearchService(
    url: string,
    { signal, account }: ReadOptions,
): Promise<WebPage | null> {
    const service = account ? SEARCH_SERVICES[account.backend] : null;
    if (!account || !service?.read) return null;
    // A private or internal address must not reach a third-party reader,
    // which would otherwise fetch or log it.
    await assertPublicAddress(url);
    try {
        const page = await service.read(url, account.apiKey, { fetch, signal });
        return page.text ? page : null;
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

/**
 * Fetches a public web page and returns its main text: article content as
 * markdown for HTML, the text layer for a PDF. When the chosen search service
 * can read pages, it tries first. Private and internal addresses are refused,
 * redirects included.
 */
export async function readWebPage(
    url: string,
    options: ReadOptions = {},
): Promise<WebPage> {
    // Search services cannot read every page, so one they could not read is
    // read here instead.
    const page =
        (await readThroughSearchService(url, options)) ??
        (await readDirectly(url, options.signal));
    const text = page.text.trim();
    if (!text) {
        throw new WebPageUnreadableError("The page has no readable text.");
    }
    return { ...page, text };
}
