import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeWithClaim } from "../execution";
import type { DbJob, DbJobExecutionContext, DbJobExecutionPolicy } from "../types";

const claim = Object.freeze({ id: "job-1", attempts: 2, claimedAt: "2026-10-13T00:00:00Z" });
const job = { id: claim.id, kind: "test.synthetic", attempts: claim.attempts, claimed_at: claim.claimedAt } as DbJob;
const policy = { heartbeatIntervalMs: 100, maxDurationMs: 30_000 };
const success = { data: [{ id: claim.id, heartbeat_at: "2026-10-13T00:00:01Z" }], error: null };
/** Expose a promise barrier for controlling late handler and transport completion. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
/** Model heartbeat responses and capture abort signals without using a live database. */
function database(responses: Array<unknown | Promise<unknown>> = []) {
    const signals: AbortSignal[] = [];
    const rpc = vi.fn(() => ({ abortSignal(signal: AbortSignal) {
        signals.push(signal);
        return Promise.resolve(responses.length ? responses.shift() : success);
    } }));
    return { db: { rpc } as never, rpc, signals };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bounded opted-in claim execution", () => {
    it("checks ownership before running and returns a handler result without timer leaks", async () => {
        const fake = database();
        const handler = vi.fn(async (_db, _job, context?: DbJobExecutionContext) => {
            expect(fake.rpc).toHaveBeenCalledOnce();
            expect(context?.claim).toBe(claim);
            expect(context?.signal.aborted).toBe(false);
            expect(context?.remainingMs()).toBeGreaterThan(0);
            return { value: 42 };
        });
        expect(await executeWithClaim(fake.db, job, claim, handler, policy))
            .toEqual({ kind: "completed", result: { value: 42 } });
        expect(fake.rpc).toHaveBeenCalledWith("heartbeat_db_job", {
            p_id: claim.id, p_attempts: claim.attempts, p_claimed_at: claim.claimedAt,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        [{ data: [], error: null }, "ownership_lost"],
        [{ data: null, error: { message: "private token" } }, "renewal_unknown"],
        [{ data: null, error: null }, "renewal_unknown"],
        [{ data: [{ id: "wrong", heartbeat_at: "2026-10-13" }], error: null }, "renewal_unknown"],
        [{ data: [{ id: claim.id, heartbeat_at: "invalid" }], error: null }, "renewal_unknown"],
    ])("never invokes body after invalid initial renewal %j", async (response, reason) => {
        const fake = database([response]);
        const handler = vi.fn();
        expect(await executeWithClaim(fake.db, job, claim, handler, policy)).toEqual({ kind: "closed", reason });
        expect(handler).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("contains a thrown transport failure", async () => {
        const db = { rpc() { throw new Error("private token"); } } as never;
        const handler = vi.fn();
        expect(await executeWithClaim(db, job, claim, handler, policy))
            .toEqual({ kind: "closed", reason: "renewal_unknown" });
        expect(handler).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("shares a single in-flight request between timer and simultaneous ownership assertions", async () => {
        const renewal = deferred<typeof success>();
        const body = deferred<void>();
        const fake = database([success, renewal.promise]);
        let context!: DbJobExecutionContext;
        const running = executeWithClaim(fake.db, job, claim, async (_db, _job, ctx) => {
            context = ctx!;
            await body.promise;
        }, policy);
        await vi.advanceTimersByTimeAsync(100);
        const first = context.assertOwnership();
        const second = context.assertOwnership();
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.rpc).toHaveBeenCalledTimes(2);
        renewal.resolve(success);
        await Promise.all([first, second]);
        body.resolve();
        expect((await running).kind).toBe("completed");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds an abort-ignoring initial RPC and never reopens on its late response", async () => {
        const late = deferred<typeof success>();
        const fake = database([late.promise]);
        const handler = vi.fn();
        const running = executeWithClaim(fake.db, job, claim, handler, policy);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await running).toEqual({ kind: "closed", reason: "renewal_unknown" });
        expect(fake.signals[0].aborted).toBe(true);
        late.resolve(success);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(handler).not.toHaveBeenCalled();
        expect(fake.rpc).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("closes a hanging handler at the deadline and consumes its late rejection", async () => {
        const late = deferred<void>();
        const fake = database();
        let context!: DbJobExecutionContext;
        const running = executeWithClaim(fake.db, job, claim, async (_db, _job, ctx) => {
            context = ctx!;
            return late.promise;
        }, { ...policy, maxDurationMs: 250 });
        await vi.advanceTimersByTimeAsync(250);
        expect(await running).toEqual({ kind: "closed", reason: "deadline" });
        expect(context.signal.aborted).toBe(true);
        const calls = fake.rpc.mock.calls.length;
        late.reject(new Error("late handler private data"));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.rpc).toHaveBeenCalledTimes(calls);
        await expect(context.assertOwnership()).rejects.toThrow("db_job_ownership_lost");
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        [{ data: [], error: null }, "ownership_lost"],
        [{ data: null, error: { message: "private renewal failure" } }, "renewal_unknown"],
    ])("aborts a running handler after failed scheduled renewal %j", async (response, reason) => {
        const body = deferred<void>();
        const fake = database([success, response]);
        let context!: DbJobExecutionContext;
        const running = executeWithClaim(fake.db, job, claim, async (_db, _job, ctx) => {
            context = ctx!;
            await body.promise;
        }, policy);
        await vi.advanceTimersByTimeAsync(100);
        expect(await running).toEqual({ kind: "closed", reason });
        expect(context.signal.aborted).toBe(true);
        body.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.rpc).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("returns a handler failure separately from lease closure", async () => {
        const failure = new Error("domain failed");
        expect(await executeWithClaim(database().db, job, claim, async () => { throw failure; }, policy))
            .toEqual({ kind: "failed", error: failure });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a bounded pending renewal after the body finishes", async () => {
        const pending = deferred<typeof success>();
        const body = deferred<void>();
        const fake = database([success, pending.promise]);
        const running = executeWithClaim(fake.db, job, claim, async () => body.promise, policy);
        await vi.advanceTimersByTimeAsync(100);
        body.resolve();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await running).toEqual({ kind: "closed", reason: "renewal_unknown" });
        pending.resolve(success);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.rpc).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])("aborts shutdown during initial/body work (preaborted=%s)", async (preaborted) => {
        const parent = new AbortController();
        const pending = deferred<typeof success>();
        const fake = database([pending.promise]);
        const handler = vi.fn();
        if (preaborted) parent.abort();
        const running = executeWithClaim(fake.db, job, claim, handler, policy, parent.signal);
        parent.abort();
        expect(await running).toEqual({ kind: "closed", reason: "shutdown" });
        pending.resolve(success);
        await vi.advanceTimersByTimeAsync(100);
        expect(handler).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops a running body and heartbeat intake on shutdown", async () => {
        const parent = new AbortController();
        const body = deferred<void>();
        const fake = database();
        let context!: DbJobExecutionContext;
        const running = executeWithClaim(fake.db, job, claim, async (_db, _job, ctx) => {
            context = ctx!;
            await body.promise;
        }, policy, parent.signal);
        await vi.advanceTimersByTimeAsync(0);
        parent.abort();
        expect(await running).toEqual({ kind: "closed", reason: "shutdown" });
        expect(context.signal.aborted).toBe(true);
        body.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.rpc).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { heartbeatIntervalMs: 0, maxDurationMs: 100 },
        { heartbeatIntervalMs: -1, maxDurationMs: 100 },
        { heartbeatIntervalMs: Number.NaN, maxDurationMs: 100 },
        { heartbeatIntervalMs: 200_001, maxDurationMs: 300_000 },
        { heartbeatIntervalMs: 600_000, maxDurationMs: 700_000 },
        { heartbeatIntervalMs: 100, maxDurationMs: 0 },
        { heartbeatIntervalMs: 100, maxDurationMs: Infinity },
        { heartbeatIntervalMs: 100, maxDurationMs: 2_147_483_648 },
    ] satisfies DbJobExecutionPolicy[])("rejects invalid policy %j without calls or timers", async (invalid) => {
        const fake = database();
        await expect(executeWithClaim(fake.db, job, claim, vi.fn(), invalid))
            .rejects.toThrow("invalid_db_job_execution_policy");
        expect(fake.rpc).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
