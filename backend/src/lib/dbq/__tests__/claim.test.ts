import { describe, expect, it, vi } from "vitest";
import { settleClaim } from "../claim";

const claim = { id: "job-1", attempts: 2, claimedAt: "2026-10-13T00:00:00Z" };
const patch = { status: "done" as const, last_error: null };

describe("settleClaim", () => {
    it.each([
        [{ data: [{ id: "job-1" }], error: null }, "committed"],
        [{ data: [], error: null }, "ownership_lost"],
        [{ data: null, error: null }, "outcome_unknown"],
        [{ data: [{ id: "other" }], error: null }, "outcome_unknown"],
        [{ data: [{ id: "job-1" }, { id: "other" }], error: null }, "outcome_unknown"],
        [{ data: [{ id: "job-1" }], error: { message: "failed" } }, "outcome_unknown"],
    ] as const)("checks the returned identity and error: %j", async (response, kind) => {
        const filters: unknown[] = [];
        const query = {
            update: vi.fn(() => query),
            eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
            select: vi.fn(async () => response),
        };
        expect((await settleClaim({ from: () => query } as never, claim, patch)).kind).toBe(kind);
        expect(filters).toEqual([
            ["id", claim.id], ["status", "running"],
            ["attempts", claim.attempts], ["claimed_at", claim.claimedAt],
        ]);
        expect(query.select).toHaveBeenCalledWith("id");
    });

    it("does not write an unclaimed row", async () => {
        const from = vi.fn();
        expect(await settleClaim({ from } as never, { ...claim, claimedAt: null }, patch))
            .toEqual({ kind: "ownership_lost" });
        expect(from).not.toHaveBeenCalled();
    });

    it("contains a thrown transport failure without a second write", async () => {
        const from = vi.fn(() => { throw new Error("lost response"); });
        expect((await settleClaim({ from } as never, claim, patch)).kind).toBe("outcome_unknown");
        expect(from).toHaveBeenCalledOnce();
    });
});


describe("live settlement", () => {
    it.each([
        [{ data: [{ id: claim.id }], error: null }, "committed"],
        [{ data: [], error: null }, "ownership_lost"],
        [{ data: null, error: { message: "unavailable" } }, "outcome_unknown"],
    ])("uses the atomic lease RPC and checks its result", async (response, kind) => {
        const rpc = vi.fn().mockResolvedValue(response);
        const from = vi.fn();
        const outcome = await settleClaim({ rpc, from } as never, claim, {
            status: "pending", last_error: "deferred", run_at: "2026-10-13T01:00:00Z",
            attempts: 1, result: { retained: true },
        }, true);
        expect(outcome.kind).toBe(kind);
        expect(from).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledExactlyOnceWith("settle_live_db_job", {
            p_id: claim.id, p_attempts: claim.attempts, p_claimed_at: claim.claimedAt,
            p_outcome: "pending", p_result: { retained: true }, p_last_error: "deferred",
            p_run_at: "2026-10-13T01:00:00Z", p_refund_attempt: true,
        });
    });
});
