import { describe, expect, it } from "vitest";
import { BULK_REQUEST_CONCURRENCY, settleBulkRequests } from "./bulkRequests";

async function tracked<T>(state: { inFlight: number; peak: number }, run: () => T) {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.inFlight--;
    return run();
}

describe("settleBulkRequests", () => {
    it("bounds in-flight requests and partitions items in input order", async () => {
        const state = { inFlight: 0, peak: 0 };
        const items = Array.from({ length: 20 }, (_, i) => i);
        const outcome = await settleBulkRequests(items, (item) =>
            tracked(state, () => {
                if (item % 7 === 3) throw new Error(`failed ${item}`);
                return item * 2;
            }),
        );
        expect(state.peak).toBe(BULK_REQUEST_CONCURRENCY);
        expect(outcome.failed).toEqual([3, 10, 17]);
        expect(outcome.succeeded).toHaveLength(17);
        expect(outcome.values[3]).toBe(8);
        expect(outcome.skipped).toEqual([]);
        expect(outcome.firstError).toEqual(new Error("failed 3"));
    });

    it("sends nothing new after a failure when asked to stop", async () => {
        const sent: number[] = [];
        const outcome = await settleBulkRequests(
            [0, 1, 2, 3, 4, 5],
            async (item) => {
                sent.push(item);
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (item === 1) throw new Error("offline");
                return item;
            },
            { concurrency: 2, stopAfterFailure: true },
        );
        // 0 and 1 run together; 1 fails, so only the request already
        // scheduled beside it (2) is sent.
        expect(sent).toEqual([0, 1, 2]);
        expect(outcome.succeeded).toEqual([0, 2]);
        expect(outcome.failed).toEqual([1]);
        expect(outcome.skipped).toEqual([3, 4, 5]);
    });
});
