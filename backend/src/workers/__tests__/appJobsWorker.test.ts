import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// The outbox contract, unit-level: enqueue writes the durable row AND hands
// its id to BullMQ; the delivery worker claims through Postgres so duplicate
// deliveries no-op; a retry is redelivered at its backoff time.

process.env.QUEUE_DRIVER = "redis";
afterAll(() => {
    delete process.env.QUEUE_DRIVER;
});

// Typed with the real enqueueAppJobDelivery's argument list so the recorded
// calls are a proper tuple rather than an untyped rest array.
type DeliveryOpts = { delayMs?: number; attempt?: number };
const enqueueAppJobDelivery = vi.fn<
    (dbJobId: string, opts?: DeliveryOpts) => Promise<unknown>
>(async () => ({}));
vi.mock("../../lib/queue/appJobsQueue", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/queue/appJobsQueue")>();
    return {
        ...actual,
        enqueueAppJobDelivery: (dbJobId: string, opts?: DeliveryOpts) =>
            enqueueAppJobDelivery(dbJobId, opts),
    };
});
vi.mock("../../lib/supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../lib/storage", () => ({ deleteFile: vi.fn() }));

import { runAppJobDelivery } from "../appJobsWorker";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { processClaimedJob } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";

const CLAIMED: DbJob = {
    id: "row-1",
    kind: "test.kind",
    payload: {},
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "",
    claimed_at: "",
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "",
};

function makeDb(opts: {
    claimRows?: DbJob[];
    claimError?: string;
    insertId?: string;
}) {
    const updates: Record<string, unknown>[] = [];
    const rpcCalls: [string, Record<string, unknown>][] = [];
    return {
        updates,
        rpcCalls,
        rpc(fn: string, args: Record<string, unknown>) {
            rpcCalls.push([fn, args]);
            return Promise.resolve(
                opts.claimError
                    ? { data: null, error: { message: opts.claimError } }
                    : { data: opts.claimRows ?? [], error: null },
            );
        },
        from() {
            const b: Record<string, unknown> = {
                insert: () => b,
                update(payload: Record<string, unknown>) {
                    updates.push(payload);
                    return b;
                },
                select: () => b,
                eq: () => b,
                single: () =>
                    Promise.resolve({
                        data: { id: opts.insertId ?? "row-1" },
                        error: null,
                    }),
                then: (onF: (v: unknown) => unknown) =>
                    Promise.resolve({ data: null, error: null }).then(onF),
            };
            return b;
        },
    };
}

beforeEach(() => enqueueAppJobDelivery.mockClear());

describe("outbox delivery on enqueue", () => {
    it("hands the inserted row's id to BullMQ when the Redis driver is active", async () => {
        const db = makeDb({ insertId: "row-9" });
        await enqueueDbJob(db as never, { kind: "x", payload: {} });
        expect(enqueueAppJobDelivery).toHaveBeenCalledWith("row-9", {
            delayMs: 0,
        });
    });

    it("a failed delivery does not fail the enqueue — the poll backstop covers it", async () => {
        enqueueAppJobDelivery.mockRejectedValueOnce(new Error("redis down"));
        const db = makeDb({ insertId: "row-9" });
        await expect(
            enqueueDbJob(db as never, { kind: "x", payload: {} }),
        ).resolves.toEqual({ id: "row-9", deduped: false });
    });
});

describe("runAppJobDelivery", () => {
    it("claims through Postgres and runs the claimed row", async () => {
        const handled: string[] = [];
        // processClaimedJob needs a handler registry — but runAppJobDelivery
        // uses the real DB_JOB_HANDLERS; instead verify via the claim + the
        // done-update the state machine writes for an unknown kind (failed).
        const db = makeDb({ claimRows: [CLAIMED] });
        await runAppJobDelivery({ dbJobId: "row-1" }, db as never);
        expect(db.rpcCalls[0][0]).toBe("claim_db_job");
        expect(db.rpcCalls[0][1]).toMatchObject({ p_id: "row-1" });
        // test.kind is not registered → the state machine marks it failed,
        // proving the claimed row went through processClaimedJob.
        expect(db.updates[0]).toMatchObject({ status: "failed" });
        void handled;
    });

    it("no-ops when the claim matches nothing (duplicate delivery)", async () => {
        const db = makeDb({ claimRows: [] });
        await runAppJobDelivery({ dbJobId: "row-1" }, db as never);
        expect(db.updates).toHaveLength(0);
    });

    it("leaves the row untouched on claim errors (poll backstop will claim it)", async () => {
        const db = makeDb({ claimError: "connection refused" });
        await runAppJobDelivery({ dbJobId: "row-1" }, db as never);
        expect(db.updates).toHaveLength(0);
    });
});

describe("retry redelivery", () => {
    it("redelivers a failed job at its backoff time instead of waiting for the poll", async () => {
        const db = makeDb({});
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("transient");
                },
            },
            { ...CLAIMED, attempts: 1, max_attempts: 3 },
        );
        expect(enqueueAppJobDelivery).toHaveBeenCalledWith("row-1", {
            delayMs: 30_000,
            attempt: 1,
        });
    });
});
