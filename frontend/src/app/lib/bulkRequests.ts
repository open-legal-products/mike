import { settleWithConcurrency } from "@mike/client";

/**
 * How many requests a bulk action keeps in flight. Enough to overlap
 * latency, few enough to leave the browser's per-host connections (six on
 * HTTP/1.1) for the rest of the page and to stay under API rate limits.
 */
export const BULK_REQUEST_CONCURRENCY = 5;

export interface BulkRequestOutcome<TItem, TResult> {
    /** Items whose request succeeded, in input order. */
    succeeded: TItem[];
    /** The successful results, parallel to `succeeded`. */
    values: TResult[];
    /** Items whose request failed, in input order. */
    failed: TItem[];
    /** Items never sent because `stopAfterFailure` saw a failure first. */
    skipped: TItem[];
    /** The first rejection in input order, for the failure notice. */
    firstError: unknown;
}

const SKIPPED = Symbol("skipped");

/**
 * The bulk-action policy over `settleWithConcurrency`: one request per item
 * through a pool of `BULK_REQUEST_CONCURRENCY`, partitioned into what
 * succeeded and what failed. With `stopAfterFailure`, nothing new is sent
 * once a request has failed (requests already in flight still finish), for
 * flows that report a single failure and leave the rest for a retry.
 */
export async function settleBulkRequests<TItem, TResult>(
    items: readonly TItem[],
    request: (item: TItem) => Promise<TResult>,
    {
        concurrency = BULK_REQUEST_CONCURRENCY,
        stopAfterFailure = false,
    }: { concurrency?: number; stopAfterFailure?: boolean } = {},
): Promise<BulkRequestOutcome<TItem, TResult>> {
    let stopped = false;
    const results = await settleWithConcurrency(items, concurrency, async (item) => {
        if (stopped) return SKIPPED;
        try {
            return await request(item);
        } catch (error) {
            if (stopAfterFailure) stopped = true;
            throw error;
        }
    });
    const outcome: BulkRequestOutcome<TItem, TResult> = {
        succeeded: [],
        values: [],
        failed: [],
        skipped: [],
        firstError: undefined,
    };
    results.forEach((result, index) => {
        const item = items[index]!;
        if (result.status === "rejected") {
            if (outcome.failed.length === 0) outcome.firstError = result.reason;
            outcome.failed.push(item);
        } else if (result.value === SKIPPED) {
            outcome.skipped.push(item);
        } else {
            outcome.succeeded.push(item);
            outcome.values.push(result.value as TResult);
        }
    });
    return outcome;
}
