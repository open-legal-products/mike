import type { WebSearchResult } from "./types";

export const MAX_SEARCH_RESULTS = 10;

export const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

/** A search API's result list as web pages, skipping anything that isn't one. */
export function webResults<T extends { url?: unknown }>(
    results: unknown,
    toResult: (result: T) => Omit<WebSearchResult, "url">,
): WebSearchResult[] {
    return ((Array.isArray(results) ? results : []) as T[])
        .filter((result) => /^https?:\/\//.test(text(result.url)))
        .map((result) => ({ url: text(result.url), ...toResult(result) }));
}
