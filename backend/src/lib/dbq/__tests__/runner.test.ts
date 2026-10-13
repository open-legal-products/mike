import { describe, it, expect, vi } from "vitest";

const delivery = vi.hoisted(() => ({ enabled: false, enqueue: vi.fn() }));
vi.mock("../driver", () => ({ redisEnabled: () => delivery.enabled }));
vi.mock("../../queue/appJobsQueue", () => ({ enqueueAppJobDelivery: delivery.enqueue }));
vi.mock("../../supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));

import {
    NonRetryableJobError,
    processClaimedJob,
    retryDelayMs,
    runDbJobTick,
    runDbJobRetentionSweep,
} from "../runner";
import { DbJobDeferredError, type DbJob } from "../types";

type Update = {
    table: string;
    payload: Record<string, unknown>;
    id?: string;
    filters: Record<string, unknown>;
};

// Chainable double recording db_jobs updates/deletes; rpc is injectable.
function makeDb(opts?: {
    rpc?: () => Promise<{ data: unknown; error: { message: string } | null }>;
    selectData?: unknown[];
    settle?: () => Promise<{ data: unknown; error: unknown }>;
}) {
    const updates: Update[] = [];
    const deletes: Record<string, unknown>[] = [];
    function from(table: string) {
        const state: {
            op: string;
            payload?: Record<string, unknown>;
            filters: Record<string, unknown>;
        } = { op: "select", filters: {} };
        const b: Record<string, unknown> = {
            update(payload: Record<string, unknown>) {
                state.op = "update";
                state.payload = payload;
                return b;
            },
            delete() {
                state.op = "delete";
                return b;
            },
            select() {
                return b;
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            neq(col: string, val: unknown) {
                const key = `neq:${col}`;
                const previous = state.filters[key];
                state.filters[key] =
                    previous === undefined
                        ? val
                        : Array.isArray(previous)
                          ? [...previous, val]
                          : [previous, val];
                return b;
            },
            lt(col: string, val: unknown) {
                state.filters[`lt:${col}`] = val;
                return b;
            },
            limit() {
                return b;
            },
            then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
                if (state.op === "update")
                    updates.push({
                        table,
                        payload: state.payload!,
                        id: state.filters.id as string,
                        filters: { ...state.filters },
                    });
                if (state.op === "delete")
                    deletes.push({ table, ...state.filters });
                if (state.op === "update" && opts?.settle) return opts.settle().then(onF, onR);
                const value =
                    state.op === "select"
                        ? { data: opts?.selectData ?? [], error: null }
                        : { data: [{ id: state.filters.id }], error: null };
                return Promise.resolve(value).then(onF);
            },
        };
        return b;
    }
    return {
        updates,
        deletes,
        from,
        rpc:
            opts?.rpc ??
            (async () => ({ data: [], error: null })),
    };
}

const JOB = (over: Partial<DbJob> = {}): DbJob => ({
    id: "job-1",
    kind: "test.kind",
    payload: {},
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "2026-08-21T00:00:00Z",
    claimed_at: "2026-08-21T00:00:01Z",
    heartbeat_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "2026-08-21T00:00:00Z",
    ...over,
});

describe("retryDelayMs", () => {
    it("backs off exponentially and caps at 30 minutes", () => {
        expect(retryDelayMs(1)).toBe(30_000);
        expect(retryDelayMs(2)).toBe(90_000);
        expect(retryDelayMs(3)).toBe(270_000);
        expect(retryDelayMs(10)).toBe(30 * 60 * 1000);
    });
});

describe("processClaimedJob fencing", () => {
    // A stale 'running' job is reclaimed by design (that IS crash recovery),
    // so two runners can hold the same row — and the "dead" one may not be
    // dead, just paused. Addressing a terminal write by id alone lets that
    // zombie mark `done` a job that is running right now, or drag a finished
    // job back to `pending` and run it a second time. `claimed_at` + `attempts`
    // name one specific claim, so only the current claimant can finalize.
    const FENCE = {
        id: "job-1",
        status: "running",
        attempts: 1,
        claimed_at: "2026-08-21T00:00:01Z",
    };

    it("fences the done write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            { "test.kind": async () => undefined },
            JOB(),
        );
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the retry write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("transient");
                },
            },
            JOB({ attempts: 1, max_attempts: 3 }),
        );
        expect(db.updates[0].payload.status).toBe("pending");
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the permanent-failure write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("fatal");
                },
            },
            JOB({ attempts: 3, max_attempts: 3 }),
        );
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].filters).toEqual({ ...FENCE, attempts: 3 });
    });

    it("fails a NonRetryableJobError immediately, with attempts left", async () => {
        // A job the domain REFUSES is not a job the network flaked on.
        // Account deletion for the only admin of a live organization will be
        // refused identically on every one of its 20 attempts; retrying it
        // for hours buries the reason and leaves the user's request in limbo.
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new NonRetryableJobError("refused by the domain");
                },
            },
            JOB({ attempts: 1, max_attempts: 20 }),
        );
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].payload.last_error).toBe("refused by the domain");
        expect(db.updates[0].payload.finished_at).toBeTruthy();
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the unknown-kind write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(db as never, {}, JOB());
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].filters).toEqual(FENCE);
    });
});

describe("processClaimedJob", () => {
    it("marks a successful job done and persists the handler's result", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            { "test.kind": async () => ({ out: 42 }) },
            JOB(),
        );
        expect(db.updates).toHaveLength(1);
        expect(db.updates[0].payload).toMatchObject({
            status: "done",
            result: { out: 42 },
        });
        expect(db.updates[0].id).toBe("job-1");
    });

    it("reschedules a failed job with backoff while attempts remain", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("transient");
                },
            },
            JOB({ attempts: 1, max_attempts: 3 }),
        );
        const [u] = db.updates;
        expect(u.payload.status).toBe("pending");
        expect(u.payload.last_error).toContain("transient");
        const runAt = new Date(u.payload.run_at as string).getTime();
        // First retry waits ~30s.
        expect(runAt - Date.now()).toBeGreaterThan(25_000);
        expect(runAt - Date.now()).toBeLessThan(35_000);
    });

    it("defers a quiet-period job without consuming its retry attempt", async () => {
        const db = makeDb();
        const runAt = new Date(Date.now() + 120_000).toISOString();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new DbJobDeferredError(runAt, "memory_quiet_period");
                },
            },
            JOB({ attempts: 2, max_attempts: 3 }),
        );
        expect(db.updates[0].payload).toMatchObject({
            status: "pending",
            attempts: 1,
            run_at: runAt,
            last_error: "memory_quiet_period",
        });
    });

    it("fails terminally once attempts are exhausted", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("still broken");
                },
            },
            JOB({ attempts: 3, max_attempts: 3 }),
        );
        expect(db.updates[0].payload).toMatchObject({ status: "failed" });
    });

    it("keeps storage.cleanup pending with an effectively unbounded retry budget", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "storage.cleanup": async () => {
                    throw new Error("storage unavailable");
                },
            },
            JOB({ kind: "storage.cleanup", attempts: 8, max_attempts: 8 }),
        );
        expect(db.updates[0].payload).toMatchObject({
            status: "pending",
            max_attempts: 2_147_483_647,
        });
    });

    it("fails an unknown kind immediately — retrying cannot fix it", async () => {
        const db = makeDb();
        await processClaimedJob(db as never, {}, JOB({ kind: "nope" }));
        expect(db.updates[0].payload).toMatchObject({ status: "failed" });
        expect(db.updates[0].payload.last_error).toContain("unknown job kind");
    });

    it("keeps an unknown cleanup kind retryable during rolling deploys", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {},
            JOB({
                kind: "storage.cleanup",
                attempts: 20,
                max_attempts: 20,
            }),
        );
        expect(db.updates[0].payload).toMatchObject({
            status: "pending",
            max_attempts: 2_147_483_647,
        });
    });
});

describe("runDbJobTick", () => {
    it("survives a claim failure (e.g. migration not applied) without throwing", async () => {
        const db = makeDb({
            rpc: async () => ({
                data: null,
                error: { message: "relation db_jobs does not exist" },
            }),
        });
        await expect(runDbJobTick(db as never, {})).resolves.toBe(0);
    });

    it("processes every claimed job even when one handler rejects unexpectedly", async () => {
        const jobs = [JOB({ id: "a" }), JOB({ id: "b" })];
        const db = makeDb({ rpc: async () => ({ data: jobs, error: null }) });
        const seen: string[] = [];
        await runDbJobTick(db as never, {
            "test.kind": async (_db, job) => {
                seen.push(job.id);
                if (job.id === "a") throw new Error("boom");
            },
        });
        expect(seen.sort()).toEqual(["a", "b"]);
    });
});

describe("runDbJobRetentionSweep", () => {
    it("deletes an expired export's storage object BEFORE dropping its row", async () => {
        const order: string[] = [];
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        const origThen = db.deletes;
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async (path) => {
                order.push(`file:${path}`);
            },
        });
        expect(order).toEqual(["file:exports/u/e1.json"]);
        expect(origThen.some((d) => d.id === "e1")).toBe(true);
    });

    it("keeps the row when the artifact delete fails, so the next sweep retries", async () => {
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async () => {
                throw new Error("storage down");
            },
        });
        expect(db.deletes.some((d) => d.id === "e1")).toBe(false);
    });

    // The keep-to-retry promise above is only real if no OTHER deleter can
    // reach the row: the generic 7-day done purge carries no id filter, so
    // once finished_at ages past DONE_RETENTION_MS it would sweep the very
    // row step 1 preserved — erasing the only pointer to an artifact whose
    // delete is still failing, and leaking a full copy of the user's data.
    it("exempts export.build from the generic done purge — kept rows are retry state", async () => {
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async () => {
                throw new Error("storage down");
            },
        });
        const donePurge = db.deletes.find(
            (d) => d.status === "done" && "lt:finished_at" in d,
        );
        expect(donePurge).toBeDefined();
        expect(donePurge?.["neq:kind"]).toBe("export.build");
    });

    it("never sweeps failed cleanup rows that own private object pointers", async () => {
        const db = makeDb();
        await runDbJobRetentionSweep(db as never);
        const failedPurge = db.deletes.find(
            (d) => d.status === "failed" && "lt:finished_at" in d,
        );
        expect(failedPurge?.["neq:kind"]).toEqual(["storage.cleanup", "document.cleanup"]);
    });
});

describe("explicit failure hooks", () => {
    it("forwards failure hooks through batch dispatch only after recording terminal failure", async () => {
        const job = JOB({ attempts: 3 });
        const db = makeDb({ rpc: async () => ({ data: [job], error: null }) });
        const hook = vi.fn(async (seenDb, seenJob) => {
            expect(seenDb).toBe(db);
            expect(seenJob).toBe(job);
            expect(db.updates[0].payload.status).toBe("failed");
        });
        await runDbJobTick(db as never, { "test.kind": async () => { throw new Error("terminal"); } }, { "test.kind": hook });
        expect(hook).toHaveBeenCalledOnce();
    });
    it("does not call terminal hooks for retryable or deferred work", async () => {
        const db = makeDb();
        const hook = vi.fn();
        for (const error of [new Error("transient"), new DbJobDeferredError(new Date(Date.now() + 5000).toISOString(), "wait")]) {
            await processClaimedJob(db as never, { "test.kind": async () => { throw error; } }, JOB(), { "test.kind": hook });
        }
        expect(hook).not.toHaveBeenCalled();
        expect(db.updates.every(row => row.payload.status === "pending")).toBe(true);
    });
    it("contains a hook failure without abandoning later batch jobs", async () => {
        const db = makeDb({ rpc: async () => ({ data: [JOB({ attempts: 3 }), JOB({ id: "next", kind: "success" })], error: null }) });
        const hook = vi.fn(async () => { throw new Error("hook unavailable"); });
        await runDbJobTick(db as never, { "test.kind": async () => { throw new Error("terminal"); }, success: async () => {} }, { "test.kind": hook });
        expect(hook).toHaveBeenCalledOnce();
        expect(db.updates.find(row => row.id === "next")?.payload.status).toBe("done");
    });

    // memory_consolidation_results rows exist only so a retried
    // memory.consolidate job applies each scope once. Nothing else deletes
    // them, so without this step the table grew without bound for the life of
    // the deployment.
    it("prunes curator receipts once their job row is old enough to sweep", async () => {
        const db = makeDb();
        await runDbJobRetentionSweep(db as never);
        const receiptPurge = db.deletes.find(
            (d) => d.table === "memory_consolidation_results",
        );
        expect(receiptPurge).toBeDefined();
        expect(receiptPurge?.["lt:created_at"]).toEqual(expect.any(String));
    });
});


describe("confirmed settlement before side effects", () => {
    it.each([
        ["lost", async () => ({ data: [], error: null })],
        ["returned error", async () => ({ data: null, error: { message: "database unavailable" } })],
        ["thrown error", async () => { throw new Error("transport unavailable"); }],
    ] as const)("suppresses hooks and retry delivery after %s settlement", async (_name, settle) => {
        delivery.enabled = true;
        delivery.enqueue.mockClear();
        const hook = vi.fn();
        try {
            for (const attempts of [1, 3]) {
                const db = makeDb({ settle });
                await processClaimedJob(db as never, {
                    "test.kind": async () => { throw new Error("handler failed"); },
                }, JOB({ attempts }), { "test.kind": hook });
                expect(db.updates).toHaveLength(1);
            }
            expect(hook).not.toHaveBeenCalled();
            expect(delivery.enqueue).not.toHaveBeenCalled();
        } finally { delivery.enabled = false; }
    });

    it("does not turn a success persistence exception into a handler retry", async () => {
        const db = makeDb({ settle: async () => { throw new Error("lost response"); } });
        const handler = vi.fn(async () => ({ value: 42 }));
        await processClaimedJob(db as never, { "test.kind": handler }, JOB());
        expect(handler).toHaveBeenCalledOnce();
        expect(db.updates).toHaveLength(1);
        expect(db.updates[0].payload.status).toBe("done");
    });

    it("redelivers only a confirmed retry", async () => {
        delivery.enabled = true;
        delivery.enqueue.mockClear();
        try {
            await processClaimedJob(makeDb() as never, {
                "test.kind": async () => { throw new Error("transient"); },
            }, JOB());
            expect(delivery.enqueue).toHaveBeenCalledOnce();
        } finally { delivery.enabled = false; }
    });
});


it("captures the immutable claim before invoking a mutable legacy handler", async () => {
    const db = makeDb();
    await processClaimedJob(db as never, { "test.kind": async (_db, job) => {
        job.id = "other-job";
        job.attempts = 99;
        job.claimed_at = "other-claim";
    } }, JOB());
    expect(db.updates[0].filters).toEqual({
        id: "job-1", status: "running", attempts: 1,
        claimed_at: "2026-08-21T00:00:01Z",
    });
});
