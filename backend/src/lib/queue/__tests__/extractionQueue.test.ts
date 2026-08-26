import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { createServerSupabase } from "../../supabase";
import type {
    EnqueueDbJobInput,
    EnqueueDbJobResult,
} from "../../dbq/enqueue";

type Db = ReturnType<typeof createServerSupabase>;

// These suites pin the REDIS driver's BullMQ semantics; the Postgres-driver
// routing (same identities, DB queue transport) is pinned separately below.
process.env.QUEUE_DRIVER = "redis";
afterAll(() => {
    delete process.env.QUEUE_DRIVER;
});

// Both stubs carry the signature of what they replace, so the recorded calls
// below are real argument tuples instead of untyped rest arrays.
const enqueueDbJob = vi.fn<
    (db: Db, input: EnqueueDbJobInput) => Promise<EnqueueDbJobResult>
>(async () => ({ id: "dbjob-1", deduped: false }));
vi.mock("../../dbq/enqueue", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../dbq/enqueue")>();
    return {
        ...actual,
        enqueueDbJob: (db: Db, input: EnqueueDbJobInput) =>
            enqueueDbJob(db, input),
    };
});
const rpc = vi.fn<
    (
        fn: string,
        params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>
>(async () => ({ data: 0, error: null }));
vi.mock("../../supabase", () => ({
    createServerSupabase: () => ({
        rpc: (fn: string, params: Record<string, unknown>) => rpc(fn, params),
    }),
}));

vi.mock("../connection", () => ({
    getRedisConnection: () => ({}),
}));

const add = vi.fn();
const getJob = vi.fn();
vi.mock("bullmq", () => ({
    Queue: class {
        add = add;
        getJob = getJob;
    },
}));

import {
    extractionJobId,
    enqueueExtraction,
    removeQueuedExtractionJobs,
    type ExtractionJobData,
} from "../extractionQueue";

const DATA: ExtractionJobData = {
    reviewId: "rev-1",
    userId: "user-1",
    rowId: "row-1",
};

beforeEach(() => {
    add.mockReset();
    getJob.mockReset();
});

describe("extractionJobId", () => {
    it("is deterministic on (reviewId, rowId)", () => {
        expect(extractionJobId("rev-1", "row-1")).toBe("extract_rev-1_row-1");
    });

    it("suffixes single-cell jobs so they never dedupe against full-row jobs", () => {
        expect(extractionJobId("rev-1", "row-1", 2)).toBe(
            "extract_rev-1_row-1_2",
        );
        expect(extractionJobId("rev-1", "row-1", 0)).toBe(
            "extract_rev-1_row-1_0",
        );
    });
});

describe("enqueueExtraction (single-cell)", () => {
    it("uses the column-suffixed jobId and carries columnIndex", () => {
        enqueueExtraction({ ...DATA, columnIndex: 1 });

        const [, data, opts] = add.mock.calls[0];
        expect(data.columnIndex).toBe(1);
        expect(opts.jobId).toBe("extract_rev-1_row-1_1");
    });
});

describe("enqueueExtraction", () => {
    it("dedupes with a deterministic jobId of extract_<reviewId>_<rowId>", () => {
        enqueueExtraction(DATA);

        expect(add).toHaveBeenCalledTimes(1);
        const [name, data, opts] = add.mock.calls[0];
        expect(name).toBe("extract");
        expect(data).toEqual(DATA);
        expect(opts.jobId).toBe("extract_rev-1_row-1");
    });

    it("retries with backoff and removes terminal jobs so re-runs can re-enqueue", () => {
        enqueueExtraction(DATA);

        const opts = add.mock.calls[0][2];
        expect(opts.attempts).toBe(3);
        expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
        // removeOnComplete/Fail === true (not a keep-N count) is deliberate:
        // durable state lives in tabular_cells, and immediate removal lets a
        // later regenerate enqueue the same deterministic jobId again.
        expect(opts.removeOnComplete).toBe(true);
        expect(opts.removeOnFail).toBe(true);
    });
});

describe("removeQueuedExtractionJobs", () => {
    const fakeJob = (state: string) => ({
        data: { reviewId: "rev-1", userId: "user-1", rowId: "row-1" },
        getState: vi.fn(async () => state),
        remove: vi.fn(async () => {}),
        updateData: vi.fn(async () => {}),
    });

    it("addresses the full-row job and every single-cell job for each row", async () => {
        getJob.mockResolvedValue(null);

        await removeQueuedExtractionJobs("rev-1", ["row-1", "row-2"], [0, 2]);

        expect(getJob.mock.calls.map((c) => c[0])).toEqual([
            "extract_rev-1_row-1",
            "extract_rev-1_row-1_0",
            "extract_rev-1_row-1_2",
            "extract_rev-1_row-2",
            "extract_rev-1_row-2_0",
            "extract_rev-1_row-2_2",
        ]);
    });

    it("removes waiting jobs; active jobs get a PERSISTED canceled marker", async () => {
        const waiting = fakeJob("waiting");
        const active = fakeJob("active");
        getJob
            .mockResolvedValueOnce(waiting)
            .mockResolvedValueOnce(active)
            .mockResolvedValue(null);

        const out = await removeQueuedExtractionJobs("rev-1", ["row-1"], [0]);

        expect(waiting.remove).toHaveBeenCalledTimes(1);
        expect(waiting.updateData).not.toHaveBeenCalled();
        // NOT Job#discard(): that flag lives only in the worker's own Job
        // instance, so from this process it would be a silent no-op. The
        // marker must go through updateData(), which persists into Redis for
        // the retry attempt to see.
        expect(active.updateData).toHaveBeenCalledWith({
            ...active.data,
            canceled: true,
        });
        expect(active.remove).not.toHaveBeenCalled();
        expect(out).toEqual({ removed: 1, canceled: 1 });
    });

    it("falls back to the canceled marker when remove() loses the race to the worker", async () => {
        const raced = fakeJob("waiting");
        raced.remove = vi.fn(async () => {
            throw new Error("job is locked");
        });
        getJob.mockResolvedValueOnce(raced).mockResolvedValue(null);

        const out = await removeQueuedExtractionJobs("rev-1", ["row-1"], [0, 1]);

        expect(raced.updateData).toHaveBeenCalledWith({
            ...raced.data,
            canceled: true,
        });
        expect(out).toEqual({ removed: 0, canceled: 1 });
        // Later jobIds are still processed after a failure.
        expect(getJob).toHaveBeenCalledTimes(3);
    });

    it("swallows per-job failures — cancellation is best-effort on top of the write guards", async () => {
        const dead = fakeJob("waiting");
        dead.remove = vi.fn(async () => {
            throw new Error("job is locked");
        });
        dead.updateData = vi.fn(async () => {
            throw new Error("Missing key for job");
        });
        getJob.mockResolvedValueOnce(dead).mockResolvedValue(null);

        await expect(
            removeQueuedExtractionJobs("rev-1", ["row-1"], [0, 1]),
        ).resolves.toEqual({ removed: 0, canceled: 0 });
        expect(getJob).toHaveBeenCalledTimes(3);
    });
});

describe("postgres driver routing", () => {
    it("enqueues to the DB queue with the jobId as dedupe key", async () => {
        process.env.QUEUE_DRIVER = "postgres";
        try {
            enqueueDbJob.mockClear();
            await enqueueExtraction({ ...DATA, columnIndex: 2 });
            const [, input] = enqueueDbJob.mock.calls[0];
            expect(input.kind).toBe("extraction.extract");
            expect(input.dedupeKey).toBe("extract_rev-1_row-1_2");
        } finally {
            process.env.QUEUE_DRIVER = "redis";
        }
    });

    it("clear-cells cancellation goes through the cancel_db_jobs RPC", async () => {
        process.env.QUEUE_DRIVER = "postgres";
        try {
            rpc.mockClear();
            rpc.mockResolvedValueOnce({ data: 3, error: null });
            const out = await removeQueuedExtractionJobs(
                "rev-1",
                ["row-1"],
                [0, 1],
            );
            expect(rpc).toHaveBeenCalledWith("cancel_db_jobs", {
                p_dedupe_keys: [
                    "extract_rev-1_row-1",
                    "extract_rev-1_row-1_0",
                    "extract_rev-1_row-1_1",
                ],
            });
            expect(out).toEqual({ removed: 3, canceled: 0 });
            // BullMQ must never be touched in this mode.
            expect(getJob).not.toHaveBeenCalled();
        } finally {
            process.env.QUEUE_DRIVER = "redis";
        }
    });
});
