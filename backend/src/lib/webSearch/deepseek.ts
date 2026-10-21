import { READ_TIMEOUT_MS, postJson } from "./http";
import { MAX_SEARCH_RESULTS, text, webResults } from "./results";
import type { SearchService } from "./types";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

type DeepSeekResult = {
    url?: unknown;
    title?: unknown;
    snippet?: unknown;
    /** A longer extract than the snippet, written for models. */
    summary?: unknown;
};

export const deepseek: SearchService = {
    maxQueryChars: 128,
    // 402 is an account without balance.
    rejectedStatuses: [401, 402],

    async search(query, apiKey, deps) {
        const body = await postJson(
            DEEPSEEK_SEARCH_URL,
            apiKey,
            { query, count: MAX_SEARCH_RESULTS },
            deps,
        );
        return webResults<DeepSeekResult>(body.results, (r) => ({
            title: text(r.title),
            snippet: text(r.summary) || text(r.snippet),
        }));
    },

    async read(url, apiKey, deps) {
        const body = await postJson(
            DEEPSEEK_FETCH_URL,
            apiKey,
            { url },
            deps,
            READ_TIMEOUT_MS,
        );
        return {
            url,
            title: text(body.title) || null,
            text: text(body.content),
        };
    },
};
