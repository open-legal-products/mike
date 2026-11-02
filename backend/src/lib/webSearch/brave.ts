import { fetchJson } from "./http";
import { MAX_SEARCH_RESULTS, text, webResults } from "./results";
import type { SearchService } from "./types";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

type BraveResult = {
    url?: unknown;
    title?: unknown;
    description?: unknown;
    extra_snippets?: unknown;
};

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
};

const decoded = (value: unknown) =>
    text(value).replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]!);

const snippetOf = (result: BraveResult) =>
    [
        decoded(result.description),
        ...(Array.isArray(result.extra_snippets)
            ? result.extra_snippets.map(decoded)
            : []),
    ]
        .filter(Boolean)
        .join(" … ");

export const brave: SearchService = {
    maxQueryChars: 400,
    // Brave answers 422 for an invalid subscription token. A 429 is only the
    // per-second limit, so it is not counted as a refused key.
    rejectedStatuses: [401, 403, 422],
    // A free Brave Search key allows one request a second.
    requestSpacingMs: 1_100,

    async search(query, apiKey, deps) {
        const url = new URL(BRAVE_SEARCH_URL);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(MAX_SEARCH_RESULTS));
        url.searchParams.set("extra_snippets", "true");
        url.searchParams.set("text_decorations", "false");
        const body = await fetchJson(
            url,
            { headers: { accept: "application/json", "x-subscription-token": apiKey } },
            deps,
        );
        const web = body.web as { results?: unknown } | undefined;
        return webResults<BraveResult>(web?.results, (r) => ({
            title: decoded(r.title),
            snippet: snippetOf(r),
        }));
    },
};
