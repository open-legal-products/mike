import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(),
}));

const loadReviewRow = vi.fn();
const loadRowDocumentText = vi.fn();
vi.mock("../../modules/tabular/tabular.rows", () => ({
    loadReviewRow: (...a: unknown[]) => loadReviewRow(...a),
    loadRowDocumentText: (...a: unknown[]) => loadRowDocumentText(...a),
}));

// The review's model is resolved through tabular.shared (router aliases + the
// owner's provider keys). Stub only that resolution; the lease helpers exported
// from the same module are the subject of the tests below and must stay real.
const validateSelectedModel = vi.fn();
vi.mock("../../modules/tabular/tabular.shared", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../modules/tabular/tabular.shared")
    >()),
    validateSelectedModel: (...a: unknown[]) => validateSelectedModel(...a),
}));

const queryTabularAllColumns = vi.fn();
vi.mock("../../modules/tabular/tabular.extract", () => ({
    queryTabularAllColumns: (...a: unknown[]) => queryTabularAllColumns(...a),
}));

import {
    runExtractionJob,
    markExtractionFailed,
    isPermanentFailure,
} from "../extractionWorker";
import type { Job } from "bullmq";
import type { ExtractionJobData } from "../../lib/queue/extractionQueue";

type Call = {
    table: string;
    op: "select" | "update" | "insert";
    payload?: Record<string, unknown>;
    filters: Record<string, unknown>;
};

type SelectResponse =
    | { data: unknown }
    | ((call: Call) => { data: unknown; error?: unknown });

// Minimal chainable Supabase test double. `responses[table].select` feeds
// select/single reads (a function form can answer per-filter, which the lease's
// "is this generation idle?" probe needs); update/insert resolve empty and are
// recorded in `calls`. `rpc` records lease calls in `rpcs`.
function makeDb(responses: Record<string, { select?: SelectResponse }>) {
    const calls: Call[] = [];
    const rpcs: { name: string; args: Record<string, unknown> }[] = [];
    function from(table: string) {
        const state: Call = { table, op: "select", filters: {} };
        const resolveRead = () => {
            const r = responses[table]?.select;
            if (typeof r === "function") return r(state);
            return r ?? { data: null };
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
            insert(payload: Record<string, unknown>) {
                state.op = "insert";
                state.payload = payload;
                calls.push({ ...state, filters: { ...state.filters } });
                return Promise.resolve({ data: null, error: null });
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            in(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            limit() {
                return b;
            },
            single() {
                calls.push({ ...state, filters: { ...state.filters } });
                return Promise.resolve(resolveRead());
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
                calls.push({ ...state, filters: { ...state.filters } });
                const value =
                    state.op === "select"
                        ? resolveRead()
                        : { data: null, error: null };
                return Promise.resolve(value).then(onF, onR);
            },
        };
        return b;
    }
    async function rpc(name: string, args: Record<string, unknown>) {
        rpcs.push({ name, args });
        return { data: true, error: null };
    }
    return { calls, rpcs, from, rpc };
}

const DATA: ExtractionJobData = {
    reviewId: "rev-1",
    userId: "user-1",
    rowId: "row-1",
};

const ROW = {
    id: "row-1",
    review_id: "rev-1",
    label: "Contract.pdf",
    row_type: "document",
    folder_id: null,
    library_folder_id: null,
    document_id: "doc-1",
    sort_index: 0,
    source_document_ids: ["doc-1"],
};

const COLUMNS = [
    { index: 0, name: "Parties", prompt: "Who are the parties?" },
    { index: 1, name: "Term", prompt: "What is the term?" },
];

const CELL = (index: number, result: Record<string, unknown>) => ({
    summary: `col ${index}`,
    flag: "green",
    reasoning: "",
    ...result,
});

beforeEach(() => {
    loadReviewRow.mockReset();
    loadReviewRow.mockResolvedValue(ROW);
    loadRowDocumentText.mockReset();
    loadRowDocumentText.mockResolvedValue("extracted text");
    queryTabularAllColumns.mockReset();
    validateSelectedModel.mockReset();
    validateSelectedModel.mockResolvedValue({
        ok: true,
        model: "claude-test",
        apiKeys: {},
    });
});

describe("runExtractionJob", () => {
    it("marks every column generating then done and publishes each", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } }, // no cells yet
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(DATA, { db: db as never, publish });

        // Two "generating" inserts (no pre-existing cells) + two "done" updates.
        const inserts = db.calls.filter((c) => c.op === "insert");
        expect(inserts).toHaveLength(2);
        expect(inserts[0].payload).toMatchObject({
            review_id: "rev-1",
            row_id: "row-1",
            document_id: "doc-1",
        });
        const doneUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "done",
        );
        expect(doneUpdates).toHaveLength(2);

        const frames = publish.mock.calls.map(
            (c) => c[1] as { status: string; row_id: string },
        );
        expect(frames.every((f) => f.row_id === "row-1")).toBe(true);
        const statuses = frames.map((f) => f.status);
        expect(statuses.filter((s) => s === "generating")).toHaveLength(2);
        expect(statuses.filter((s) => s === "done")).toHaveLength(2);
    });

    it("reuses existing cell records (update, not insert) when they already exist", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: {
                    data: [
                        { id: "c0", column_index: 0, status: "error", content: null },
                        { id: "c1", column_index: 1, status: "pending", content: null },
                    ],
                },
            },
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(DATA, { db: db as never, publish });

        expect(db.calls.filter((c) => c.op === "insert")).toHaveLength(0);
        const generatingUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "generating",
        );
        expect(generatingUpdates).toHaveLength(2);
    });

    it("skips columns already done with content — no LLM call", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: {
                    data: [
                        { id: "c0", column_index: 0, status: "done", content: "{}" },
                        { id: "c1", column_index: 1, status: "done", content: "{}" },
                    ],
                },
            },
        });

        await runExtractionJob(DATA, { db: db as never, publish });

        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("throws when the model omits a column so BullMQ retries", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } },
        });
        // Only column 0 comes back.
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, _cols, onResult) => {
                await onResult(0, CELL(0, {}));
            },
        );

        await expect(
            runExtractionJob(DATA, { db: db as never, publish }),
        ).rejects.toThrow(/incomplete extraction/);
    });

    it("restricts a single-cell job (columnIndex) to its one column", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: {
                    data: [
                        // Both cells are outstanding, but the job only owns col 1.
                        { id: "c0", column_index: 0, status: "pending", content: null },
                        { id: "c1", column_index: 1, status: "generating", content: null },
                    ],
                },
            },
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(
            { ...DATA, columnIndex: 1 },
            { db: db as never, publish },
        );

        // The LLM call was scoped to exactly one column.
        const passedColumns = queryTabularAllColumns.mock.calls[0][3] as {
            index: number;
        }[];
        expect(passedColumns.map((c) => c.index)).toEqual([1]);
        // Only column 1's cell was touched.
        const updates = db.calls.filter((c) => c.op === "update");
        expect(
            updates.every((c) => c.filters.column_index === 1 || c.filters.id === "c1"),
        ).toBe(true);
    });

    it("returns early on a canceled job without touching the DB (clear-cells won)", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } },
        });

        // clear-cells marked the job canceled while a prior attempt was
        // active; this retry re-fetched the data and must be a no-op.
        await runExtractionJob(
            { ...DATA, canceled: true },
            { db: db as never, publish },
        );

        expect(db.calls).toHaveLength(0);
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("a canceled leased job drops its stamp and releases the lease", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            // No cell still carries gen-1 once the stamp is dropped.
            tabular_cells: { select: { data: [] } },
        });

        await runExtractionJob(
            { ...DATA, generationId: "gen-1", canceled: true },
            { db: db as never, publish },
        );

        // Cancellation is a settled outcome, not a retry: the row's cells
        // belong to clear-cells now, so the job un-stamps what it owned...
        const stampClears = db.calls.filter(
            (c) => c.op === "update" && c.payload?.generation_id === null,
        );
        expect(stampClears).toHaveLength(1);
        expect(stampClears[0].filters).toMatchObject({
            review_id: "rev-1",
            row_id: "row-1",
            generation_id: "gen-1",
        });
        // ...and releases the lease, instead of holding it to its timeout.
        expect(db.rpcs.map((r) => r.name)).toContain(
            "finish_tabular_review_generation",
        );
        // Nothing was extracted or announced.
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("a canceled single-cell job un-stamps only its own column", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } },
        });

        await runExtractionJob(
            { ...DATA, generationId: "gen-1", columnIndex: 1, canceled: true },
            { db: db as never, publish },
        );

        const stampClears = db.calls.filter(
            (c) => c.op === "update" && c.payload?.generation_id === null,
        );
        expect(stampClears).toHaveLength(1);
        expect(stampClears[0].filters.column_index).toBe(1);
    });

    it("throws when the review's model is no longer usable", async () => {
        // The enqueuing request validated the model, but a review can be
        // re-pointed (or the owner's key removed) before the job runs. Throwing
        // sends the row down the normal retry/permanent-failure path, which
        // leaves the grid in a terminal "error" state rather than spinning.
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } },
        });
        validateSelectedModel.mockResolvedValue({
            ok: false,
            status: 422,
            body: { code: "missing_api_key", detail: "no key" },
        });

        await expect(
            runExtractionJob(DATA, { db: db as never, publish }),
        ).rejects.toThrow(/model unusable/);
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
    });

    it("returns early when the review has no columns", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: [], model: "claude-test" },
                },
            },
        });

        await runExtractionJob(DATA, { db: db as never, publish });

        expect(loadReviewRow).not.toHaveBeenCalled();
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(db.calls.some((c) => c.table === "tabular_cells")).toBe(false);
    });

    it("returns early when the row no longer exists (deleted between enqueue and run)", async () => {
        const publish = vi.fn(async () => {});
        loadReviewRow.mockResolvedValue(null);
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
        });

        await runExtractionJob(DATA, { db: db as never, publish });

        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(db.calls.some((c) => c.table === "tabular_cells")).toBe(false);
    });
});

describe("markExtractionFailed", () => {
    it("only touches its own column for a single-cell job", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_cells: {
                select: {
                    data: [
                        { id: "c0", column_index: 0, status: "generating", content: null },
                        { id: "c1", column_index: 1, status: "generating", content: null },
                    ],
                },
            },
        });

        await markExtractionFailed(
            { ...DATA, columnIndex: 1 },
            { db: db as never, publish },
        );

        const errorUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "error",
        );
        expect(errorUpdates).toHaveLength(1);
        // Terminal writes go through finalizeCell, which addresses a cell by
        // (review, row, column) rather than by its primary key.
        expect(errorUpdates[0].filters).toMatchObject({
            review_id: "rev-1",
            row_id: "row-1",
            column_index: 1,
        });
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it("marks only unfinished cells error and publishes them", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_cells: {
                select: {
                    data: [
                        { id: "c0", column_index: 0, status: "generating", content: null },
                        { id: "c1", column_index: 1, status: "done", content: "{}" },
                    ],
                },
            },
        });

        await markExtractionFailed(DATA, { db: db as never, publish });

        const errorUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "error",
        );
        expect(errorUpdates).toHaveLength(1);
        expect(errorUpdates[0].filters).toMatchObject({
            review_id: "rev-1",
            row_id: "row-1",
            column_index: 0,
        });
        // The terminal write also clears any generation stamp.
        expect(errorUpdates[0].payload).toMatchObject({
            status: "error",
            content: null,
            generation_id: null,
        });
        expect(publish).toHaveBeenCalledTimes(1);
        const frame = publish.mock.calls[0][1] as {
            row_id: string;
            column_index: number;
        };
        expect(frame.row_id).toBe("row-1");
        expect(frame.column_index).toBe(0);
    });

    it("leaves cells claimed by a newer generation alone", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_cells: {
                select: {
                    data: [
                        {
                            id: "c0",
                            column_index: 0,
                            status: "generating",
                            content: null,
                            generation_id: "gen-2", // a newer run owns this cell
                        },
                        {
                            id: "c1",
                            column_index: 1,
                            status: "generating",
                            content: null,
                            generation_id: "gen-1",
                        },
                    ],
                },
            },
        });

        await markExtractionFailed(
            { ...DATA, generationId: "gen-1" },
            { db: db as never, publish },
        );

        const errorUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "error",
        );
        expect(errorUpdates).toHaveLength(1);
        expect(errorUpdates[0].filters).toMatchObject({
            column_index: 1,
            generation_id: "gen-1",
        });
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it("leaves cells clear-cells revoked (unstamped, pending) alone", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_cells: {
                select: {
                    data: [
                        // The user ran clear-cells while the job was retrying:
                        // content blanked, status back to "pending", stamp
                        // dropped. That reset must win — flipping this to
                        // "error" would silently undo the user's action.
                        {
                            id: "c0",
                            column_index: 0,
                            status: "pending",
                            content: null,
                            generation_id: null,
                        },
                        // Still claimed by this job: flips to error as before.
                        {
                            id: "c1",
                            column_index: 1,
                            status: "generating",
                            content: null,
                            generation_id: "gen-1",
                        },
                    ],
                },
            },
        });

        await markExtractionFailed(
            { ...DATA, generationId: "gen-1" },
            { db: db as never, publish },
        );

        const errorUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "error",
        );
        expect(errorUpdates).toHaveLength(1);
        expect(errorUpdates[0].filters).toMatchObject({
            column_index: 1,
            generation_id: "gen-1",
        });
        expect(publish).toHaveBeenCalledTimes(1);
        expect(
            (publish.mock.calls[0][1] as { column_index: number }).column_index,
        ).toBe(1);
    });

    it("still finalizes an unstamped cell when the job carries no generation", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_cells: {
                select: {
                    data: [
                        {
                            id: "c0",
                            column_index: 0,
                            status: "generating",
                            content: null,
                            generation_id: null,
                        },
                    ],
                },
            },
        });

        // No lease in play, so there is no stamp to reason about: the cell
        // belongs to no run and must not be left spinning forever.
        await markExtractionFailed(DATA, { db: db as never, publish });

        const errorUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "error",
        );
        expect(errorUpdates).toHaveLength(1);
        expect(errorUpdates[0].filters.generation_id).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(1);
    });
});

describe("generation lease", () => {
    it("stamps and guards cell writes with the job's generation id", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: (call) =>
                    // The idleness probe filters on generation_id; answer it
                    // with "nothing left" so the lease gets released.
                    call.filters.generation_id
                        ? { data: [] }
                        : {
                              data: [
                                  {
                                      id: "c0",
                                      column_index: 0,
                                      status: "pending",
                                      content: null,
                                  },
                                  {
                                      id: "c1",
                                      column_index: 1,
                                      status: "pending",
                                      content: null,
                                  },
                              ],
                          },
            },
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(
            { ...DATA, generationId: "gen-1" },
            { db: db as never, publish },
        );

        const generatingUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "generating",
        );
        expect(generatingUpdates).toHaveLength(2);
        expect(
            generatingUpdates.every((c) => c.payload?.generation_id === "gen-1"),
        ).toBe(true);

        const doneUpdates = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "done",
        );
        expect(doneUpdates).toHaveLength(2);
        // Terminal writes clear the stamp AND are guarded by it, so a
        // superseded run can never overwrite the winner's results.
        expect(
            doneUpdates.every(
                (c) =>
                    c.payload?.generation_id === null &&
                    c.filters.generation_id === "gen-1",
            ),
        ).toBe(true);
    });

    it("releases the lease once no cell still carries the generation id", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: (call) =>
                    call.filters.generation_id ? { data: [] } : { data: [] },
            },
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(
            { ...DATA, generationId: "gen-1" },
            { db: db as never, publish },
        );

        expect(db.rpcs.map((r) => r.name)).toContain(
            "finish_tabular_review_generation",
        );
        expect(db.rpcs.at(-1)?.args).toMatchObject({
            target_review_id: "rev-1",
            target_generation_id: "gen-1",
        });
    });

    it("keeps the lease while cells are still claimed (retry pending)", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: {
                select: (call) =>
                    call.filters.generation_id
                        ? { data: [{ id: "c1" }] } // still mid-flight
                        : { data: [] },
            },
        });
        // Only column 0 comes back → the job throws for a BullMQ retry.
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, _cols, onResult) => {
                await onResult(0, CELL(0, {}));
            },
        );

        await expect(
            runExtractionJob(
                { ...DATA, generationId: "gen-1" },
                { db: db as never, publish },
            ),
        ).rejects.toThrow(/incomplete extraction/);

        expect(db.rpcs.map((r) => r.name)).not.toContain(
            "finish_tabular_review_generation",
        );
    });

    it("takes no lease action when the job carries no generation id", async () => {
        const publish = vi.fn(async () => {});
        const db = makeDb({
            tabular_reviews: {
                select: {
                    data: { columns_config: COLUMNS, model: "claude-test" },
                },
            },
            tabular_cells: { select: { data: [] } },
        });
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, CELL(c.index, {}));
            },
        );

        await runExtractionJob(DATA, { db: db as never, publish });

        expect(db.rpcs).toHaveLength(0);
    });
});

describe("isPermanentFailure", () => {
    const job = (attemptsMade: number, attempts?: number) =>
        ({ attemptsMade, opts: { attempts } }) as unknown as Job<ExtractionJobData>;

    it("is false while retries remain", () => {
        expect(isPermanentFailure(job(1, 3))).toBe(false);
        expect(isPermanentFailure(job(2, 3))).toBe(false);
    });

    it("is true once retries are exhausted", () => {
        expect(isPermanentFailure(job(3, 3))).toBe(true);
    });
});
