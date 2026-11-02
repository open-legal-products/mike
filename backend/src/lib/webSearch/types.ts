import type { WebSearchBackend } from "./settings";

export type WebSearchResult = { url: string; title: string; snippet: string };

export type WebPage = {
    url: string;
    title: string | null;
    text: string;
};

/** The search service Mike uses for a turn, with the key it runs on. */
export type WebSearchAccount = { backend: WebSearchBackend; apiKey: string };

export type SearchApiDeps = {
    fetch: typeof fetch;
    signal?: AbortSignal;
};

export type SearchService = {
    /** The longest query the service accepts. */
    maxQueryChars: number;
    /** HTTP statuses that mean the key or its plan was refused. */
    rejectedStatuses: readonly number[];
    /** The least time between two requests made with the same key. */
    requestSpacingMs?: number;
    search(
        query: string,
        apiKey: string,
        deps: SearchApiDeps,
    ): Promise<WebSearchResult[]>;
    /** Reads a page on the search service's servers instead of Mike's. */
    read?(url: string, apiKey: string, deps: SearchApiDeps): Promise<WebPage>;
};
