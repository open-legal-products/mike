import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../supabase", () => ({
    createServerSupabase: vi.fn(),
}));

const conversionGetJob = vi.fn();
vi.mock("../../queue/conversionQueue", () => ({
    getConversionQueue: () => ({ getJob: conversionGetJob }),
    conversionJobId: (versionId: string) => `convert_${versionId}`,
}));

const extractionGetJob = vi.fn();
vi.mock("../../queue/extractionQueue", () => ({
    getExtractionQueue: () => ({ getJob: extractionGetJob }),
    extractionJobId: (reviewId: string, rowId: string, columnIndex?: number) =>
        columnIndex == null
            ? `extract_${reviewId}_${rowId}`
            : `extract_${reviewId}_${rowId}_${columnIndex}`,
}));

import {
    sweepStaleProcessingDocuments,
    sweepStaleGeneratingCells,
} from "../staleWork";

type Call = {
    table: string;
    op: "select" | "update";
    payload?: Record<string, unknown>;
    filters: Record<string, unknown>;
    /** Set when the query narrowed with .limit() (the bound is in `filters`). */
    limited?: boolean;
    /** Set when the query asked for a single row (.maybeSingle()). */
    single?: boolean;
};

type Responder = unknown[] | ((call: Call) => unknown[]);

// Chainable Supabase double: select responses come from `responses[table]`
// (an array, or a function of the recorded call for tables that are read more
// than once); updates resolve empty and are recorded. `rpc` calls are recorded
// too — the reaper releases a dead generation's lease through one.
function makeDb(responses: Record<string, Responder>) {
    const calls: Call[] = [];
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
    function from(table: string) {
        const state: Call = { table, op: "select", filters: {} };
        const resolve = () => {
            const call = { ...state, filters: { ...state.filters } };
            calls.push(call);
            if (state.op !== "select") return { data: null, error: null };
            const responder = responses[table];
            const rows =
                typeof responder === "function"
                    ? responder(call)
                    : (responder ?? []);
            return state.single
                ? { data: rows[0] ?? null, error: null }
                : { data: rows, error: null };
        };
        const b: Record<string, unknown> = {
            select() {
                state.op = "select";
                return b;
            },
            update(payload: Record<string, unknown>) {
                state.op = "update";
                state.payload = payload;
                return b;
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            lt(col: string, val: unknown) {
                state.filters[`lt:${col}`] = val;
                return b;
            },
            limit(n: number) {
                state.limited = true;
                state.filters["limit"] = n;
                return b;
            },
            maybeSingle() {
                state.single = true;
                return Promise.resolve(resolve());
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
                return Promise.resolve(resolve()).then(onF, onR);
            },
        };
        return b;
    }
    async function rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        return { data: true, error: null };
    }
    return { calls, rpcCalls, from, rpc };
}

/** A review row whose generation lease is gone — the reaper's precondition. */
const NO_LEASE = [
    { active_generation_id: null, generation_lease_expires_at: null },
];
/** A review row still holding a live lease: a running owner. */
const LIVE_LEASE = [
    {
        active_generation_id: "gen-live",
        generation_lease_expires_at: new Date(
            Date.now() + 60_000,
        ).toISOString(),
    },
];

const ENV_KEYS = [
    "ASYNC_DOCUMENT_CONVERSION",
    "ASYNC_TABULAR_EXTRACTION",
    "STALE_DOC_PROCESSING_MS",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    conversionGetJob.mockReset();
    extractionGetJob.mockReset();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe("sweepStaleProcessingDocuments", () => {
    it("flips stale processing documents to error (queue off: no job check)", async () => {
        const db = makeDb({
            documents: [
                { id: "doc-1", current_version_id: "ver-1" },
                { id: "doc-2", current_version_id: null },
            ],
        });

        const flipped = await sweepStaleProcessingDocuments(db as never);

        expect(flipped).toBe(2);
        expect(conversionGetJob).not.toHaveBeenCalled();
        const updates = db.calls.filter((c) => c.op === "update");
        expect(updates).toHaveLength(2);
        // Guarded flip: only rows still "processing" are touched.
        expect(updates[0].filters.status).toBe("processing");
        expect(updates[0].payload?.status).toBe("error");
    });

    it("skips documents whose conversion job is still live (queue on)", async () => {
        process.env.ASYNC_DOCUMENT_CONVERSION = "true";
        conversionGetJob.mockImplementation(async (jobId: string) =>
            jobId === "convert_ver-live" ? { id: jobId } : null,
        );
        const db = makeDb({
            documents: [
                { id: "doc-live", current_version_id: "ver-live" },
                { id: "doc-dead", current_version_id: "ver-dead" },
            ],
        });

        const flipped = await sweepStaleProcessingDocuments(db as never);

        expect(flipped).toBe(1);
        const updates = db.calls.filter((c) => c.op === "update");
        expect(updates).toHaveLength(1);
        expect(updates[0].filters.id).toBe("doc-dead");
    });
});

describe("sweepStaleGeneratingCells", () => {
    it("is a no-op when the extraction queue is disabled", async () => {
        const db = makeDb({ tabular_cells: [{ id: "c1" }] });

        const flipped = await sweepStaleGeneratingCells(db as never);

        expect(flipped).toBe(0);
        expect(db.calls).toHaveLength(0);
    });

    it("flips orphaned generating cells and spares those with a live job", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        extractionGetJob.mockImplementation(async (jobId: string) =>
            jobId === "extract_rev-1_row-live" ? { id: jobId } : null,
        );
        const db = makeDb({
            tabular_reviews: NO_LEASE,
            // The sweep's own scan; the idleness probe (the query filtered by
            // generation_id) sees nothing left carrying the generation id.
            // Both queries bound themselves with .limit now, so the filter is
            // what tells them apart.
            tabular_cells: (call) =>
                call.filters.generation_id !== undefined
                    ? []
                    : [
                          {
                              id: "c-live",
                              review_id: "rev-1",
                              row_id: "row-live",
                              column_index: 0,
                              generation_id: "gen-dead",
                          },
                          {
                              id: "c-dead",
                              review_id: "rev-1",
                              row_id: "row-dead",
                              column_index: 1,
                              generation_id: "gen-dead",
                          },
                      ],
        });

        const flipped = await sweepStaleGeneratingCells(db as never);

        expect(flipped).toBe(1);
        const updates = db.calls.filter((c) => c.op === "update");
        expect(updates).toHaveLength(1);
        // finalizeCell addresses the cell by (review, row, column) and guards
        // on the stamp it was read with; the write clears that stamp.
        expect(updates[0].filters).toMatchObject({
            review_id: "rev-1",
            row_id: "row-dead",
            column_index: 1,
            generation_id: "gen-dead",
        });
        expect(updates[0].payload).toMatchObject({
            status: "error",
            content: null,
            generation_id: null,
        });
        // With the last stamp gone, the dead run's lease is released.
        expect(db.rpcCalls).toEqual([
            {
                fn: "finish_tabular_review_generation",
                args: {
                    target_review_id: "rev-1",
                    target_generation_id: "gen-dead",
                },
            },
        ]);
    });

    it("spares a cell whose single-cell (regenerate) job is live", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        extractionGetJob.mockImplementation(async (jobId: string) =>
            jobId === "extract_rev-1_row-1_2" ? { id: jobId } : null,
        );
        const db = makeDb({
            tabular_reviews: NO_LEASE,
            tabular_cells: [
                { id: "c2", review_id: "rev-1", row_id: "row-1", column_index: 2 },
            ],
        });

        const flipped = await sweepStaleGeneratingCells(db as never);

        expect(flipped).toBe(0);
        expect(db.calls.filter((c) => c.op === "update")).toHaveLength(0);
    });

    it("spares every cell of a review that still holds its generation lease", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        extractionGetJob.mockResolvedValue(null); // no job yet — mid hand-off
        const db = makeDb({
            tabular_reviews: LIVE_LEASE,
            tabular_cells: [
                {
                    id: "c1",
                    review_id: "rev-1",
                    row_id: "row-1",
                    column_index: 0,
                    generation_id: "gen-live",
                },
            ],
        });

        const flipped = await sweepStaleGeneratingCells(db as never);

        expect(flipped).toBe(0);
        // The lease alone settles it — no job lookup, no write.
        expect(extractionGetJob).not.toHaveBeenCalled();
        expect(db.calls.filter((c) => c.op === "update")).toHaveLength(0);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it("keeps the lease when other cells of the run are still stamped", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        extractionGetJob.mockResolvedValue(null);
        const db = makeDb({
            tabular_reviews: NO_LEASE,
            tabular_cells: (call) =>
                call.filters.generation_id !== undefined
                    ? [{ id: "still-stamped" }]
                    : [
                          {
                              id: "c1",
                              review_id: "rev-1",
                              row_id: "row-1",
                              column_index: 0,
                              generation_id: "gen-dead",
                          },
                      ],
        });

        const flipped = await sweepStaleGeneratingCells(db as never);

        expect(flipped).toBe(1);
        expect(db.rpcCalls).toHaveLength(0);
    });
});
