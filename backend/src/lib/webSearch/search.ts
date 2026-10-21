import { setTimeout as sleep } from "node:timers/promises";

import { SearchApiError } from "./http";
import { SEARCH_SERVICES } from "./services";
import type { WebSearchAccount, WebSearchResult } from "./types";

export class WebSearchUnavailableError extends Error {
    constructor(
        readonly code: "not_configured" | "rejected" | "failed",
        options?: ErrorOptions,
    ) {
        super(`Web search unavailable: ${code}`, options);
        this.name = "WebSearchUnavailableError";
    }
}

// A turn's searches run in parallel, and a deployment's key is shared by
// everyone without their own, so the wait for a rate-limited key is capped.
const MAX_QUEUE_WAIT_MS = 10_000;

type Deps = {
    fetch: typeof fetch;
    now: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function createWebSearch(deps: Deps) {
    const nextSlotAt = new Map<string, number>();

    async function waitForSlot(
        apiKey: string,
        spacingMs: number,
        signal?: AbortSignal,
    ) {
        const now = deps.now();
        const slot = Math.max(now, nextSlotAt.get(apiKey) ?? now);
        if (slot - now > MAX_QUEUE_WAIT_MS) {
            throw new WebSearchUnavailableError("failed");
        }
        nextSlotAt.set(apiKey, slot + spacingMs);
        if (slot > now) await deps.sleep(slot - now, signal);
    }

    return async function searchWeb(
        query: string,
        options: { account: WebSearchAccount | null; signal?: AbortSignal },
    ): Promise<WebSearchResult[]> {
        const { account, signal } = options;
        if (!account) throw new WebSearchUnavailableError("not_configured");
        const { apiKey } = account;
        const service = SEARCH_SERVICES[account.backend];

        if (service.requestSpacingMs) {
            await waitForSlot(apiKey, service.requestSpacingMs, signal);
        }
        try {
            return await service.search(
                query.slice(0, service.maxQueryChars),
                apiKey,
                { fetch: deps.fetch, signal },
            );
        } catch (error) {
            if (signal?.aborted) throw error;
            const rejected =
                error instanceof SearchApiError &&
                service.rejectedStatuses.includes(error.status);
            throw new WebSearchUnavailableError(rejected ? "rejected" : "failed", {
                cause: error,
            });
        }
    };
}

export const searchWeb = createWebSearch({
    fetch,
    now: Date.now,
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
});
