import type { WebSource, WebToolEvent } from "@mike/contracts";
import type { ProviderWebSearchEvent } from "../../../../lib/llm";
import {
    allowWebPage,
    chargeWeb,
    webRemaining,
    webToolError,
    type WebTurnState,
} from "./webSearchTools";

const PROVIDER_MAX_SEARCHES = 5;

export function createProviderWebSearchTracker(state: WebTurnState) {
    const cited = new Map<string, WebSource>();
    let reserved = 0;
    let started = 0;
    return {
        /**
         * Takes the stream's searches from the budget before it starts, so
         * parallel subagents can't each spend the same remainder.
         */
        reserve(): number {
            reserved = Math.min(PROVIDER_MAX_SEARCHES, webRemaining(state, "searches"));
            chargeWeb(state, "searches", reserved);
            return reserved;
        },
        /** Gives back what the stream didn't search. */
        release() {
            chargeWeb(state, "searches", started - reserved);
            reserved = started = 0;
        },
        handle(event: ProviderWebSearchEvent): {
            frame?: { type: "web_search_start"; search_id: string; query?: string };
            event?: WebToolEvent;
        } {
            switch (event.kind) {
                case "search_started":
                    started += 1;
                    return {
                        frame: {
                            type: "web_search_start",
                            search_id: event.id,
                            ...(event.query ? { query: event.query } : {}),
                        },
                    };
                case "search_finished":
                    for (const result of event.results) allowWebPage(state, result.url);
                    return {
                        event: {
                            type: "web_search",
                            search_id: event.id,
                            query: event.query ?? "",
                            results: event.results,
                            ...(event.failed ? webToolError("failed") : {}),
                        },
                    };
                case "cited_source":
                    allowWebPage(state, event.source.url);
                    if (!cited.has(event.source.url)) {
                        cited.set(event.source.url, event.source);
                    }
                    return {};
                case "unavailable":
                    return {
                        event: {
                            type: "web_search",
                            search_id: "provider-unavailable",
                            query: "",
                            results: [],
                            ...webToolError("unavailable"),
                        },
                    };
            }
        },
        citedSources(): WebToolEvent | null {
            return cited.size
                ? { type: "web_sources", sources: [...cited.values()] }
                : null;
        },
    };
}
