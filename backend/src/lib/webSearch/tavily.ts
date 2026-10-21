import { READ_TIMEOUT_MS, postJson } from "./http";
import { MAX_SEARCH_RESULTS, text, webResults } from "./results";
import type { SearchService } from "./types";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

type TavilyResult = { url?: unknown; title?: unknown; content?: unknown };

type TavilyPage = { url?: unknown; raw_content?: unknown };

export const tavily: SearchService = {
    maxQueryChars: 400,
    // 432 and 433 are the key's plan and pay-as-you-go limits.
    rejectedStatuses: [401, 432, 433],

    async search(query, apiKey, deps) {
        const body = await postJson(
            TAVILY_SEARCH_URL,
            apiKey,
            {
                query,
                max_results: MAX_SEARCH_RESULTS,
                search_depth: "basic",
            },
            deps,
        );
        return webResults<TavilyResult>(body.results, (r) => ({
            title: text(r.title),
            snippet: text(r.content),
        }));
    },

    async read(url, apiKey, deps) {
        const body = await postJson(
            TAVILY_EXTRACT_URL,
            apiKey,
            { urls: [url], extract_depth: "basic", format: "markdown" },
            deps,
            READ_TIMEOUT_MS,
        );
        const [page] = (Array.isArray(body.results) ? body.results : []) as TavilyPage[];
        return {
            url: text(page?.url) || url,
            title: null,
            text: text(page?.raw_content),
        };
    },
};
