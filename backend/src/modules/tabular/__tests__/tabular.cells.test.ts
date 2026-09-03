// Unit tests for the two lease-holding cell services.
//
// Both take the review's generation lease for their whole duration, so the
// behavior worth pinning is not the happy path but the lease discipline: the
// pre-check that answers 409 without a round trip, each answer
// `begin_tabular_review_generation` can give, and — above all — that the lease
// is released on EVERY exit, including the failing ones.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureReviewAccess, filterAccessibleDocumentIds } = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => ({
    ensureReviewAccess,
    filterAccessibleDocumentIds,
}));

const { enqueueExtraction, removeQueuedExtractionJobs } = vi.hoisted(() => ({
    enqueueExtraction: vi.fn(),
    removeQueuedExtractionJobs: vi.fn(),
}));
vi.mock("../../../lib/queue/extractionQueue", () => ({
    enqueueExtraction,
    removeQueuedExtractionJobs,
}));

const queryTabularCell = vi.hoisted(() => vi.fn());
vi.mock("../tabular.extract", () => ({ queryTabularCell }));

const finalizeCell = vi.hoisted(() => vi.fn());
vi.mock("../tabular.extractRow", () => ({ finalizeCell }));

const awaitCellTerminal = vi.hoisted(() => vi.fn());
vi.mock("../tabular.generateStream", () => ({ awaitCellTerminal }));

const { loadReviewRows, loadRowDocumentText } = vi.hoisted(() => ({
    loadReviewRows: vi.fn(),
    loadRowDocumentText: vi.fn(),
}));
vi.mock("../tabular.rows", () => ({ loadReviewRows, loadRowDocumentText }));

const validateSelectedModel = vi.hoisted(() => vi.fn());
vi.mock("../tabular.shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.shared")>()),
    validateSelectedModel,
}));

import {
    clearTabularReviewCells,
    regenerateTabularCell,
} from "../tabular.cells";
import { callTo, makeFakeDb } from "./fakeDb";

const LOG = { error: vi.fn() };
const WHO = { userId: "user-1", userEmail: "me@example.com" };
const ROW = {
    id: "row-1",
    review_id: "rev-1",
    label: "Contract.pdf",
    row_type: "document" as const,
    folder_id: null,
    library_folder_id: null,
    document_id: "doc-1",
    sort_index: 0,
    source_document_ids: ["doc-1"],
};

/** A review row with no live lease on it. */
const REVIEW = {
    id: "rev-1",
    user_id: "user-1",
    updated_at: "2026-01-01T00:00:00.000Z",
    columns_config: [{ index: 0, name: "A", prompt: "a" }],
    model: "claude-sonnet-5",
    active_generation_id: null,
    generation_lease_expires_at: null,
};

const started = () => ({ data: "started", error: null });

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ASYNC_TABULAR_EXTRACTION;
    ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: true });
    filterAccessibleDocumentIds.mockResolvedValue(["doc-1"]);
    loadReviewRows.mockResolvedValue([ROW]);
    loadRowDocumentText.mockResolvedValue("markdown");
    validateSelectedModel.mockResolvedValue({
        ok: true,
        model: "claude-sonnet-5",
        apiKeys: {},
    });
});

describe("clearTabularReviewCells", () => {
    const call = (dbSpec = {}) =>
        clearTabularReviewCells(makeFakeDb(dbSpec).db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1"],
            log: LOG,
        });

    it("404s a review the caller may not see", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const result = await call({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("409s from the live-lease pre-check without calling the RPC", async () => {
        const fake = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: {
                        ...REVIEW,
                        active_generation_id: "gen-1",
                        generation_lease_expires_at: new Date(
                            Date.now() + 60_000,
                        ).toISOString(),
                    },
                    error: null,
                },
            },
        });
        const result = await clearTabularReviewCells(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1"],
            log: LOG,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "conflict",
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
        expect(fake.rpcCalls).toEqual([]);
    });

    it.each([
        ["running", "review_running", "This tabular review is currently running."],
        [
            "stale",
            "review_stale",
            "A newer version of this tabular review is available.",
        ],
    ])("409s when the lease claim answers %s", async (answer, code, detail) => {
        const result = await call({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: () => ({ data: answer, error: null }),
        });
        expect(result).toMatchObject({ ok: false, kind: "conflict", code, detail });
    });

    it("500s with its own wording on an unrecognized claim answer", async () => {
        const result = await call({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: () => ({ data: "wat", error: null }),
        });
        expect(result).toMatchObject({ ok: false, kind: "status", status: 500 });
        expect(
            result.ok === false && result.kind === "status" && result.body,
        ).toEqual({ detail: "Failed to clear tabular review cells" });
    });

    it("blanks the rows' cells and releases the lease", async () => {
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await clearTabularReviewCells(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1", "row-2"],
            log: LOG,
        });
        expect(result).toEqual({ ok: true, data: null });
        expect(callTo(fake.calls, "tabular_cells")).toMatchObject({
            op: "update",
            payload: { content: null, status: "pending", generation_id: null },
            filters: { review_id: "rev-1", row_id: ["row-1", "row-2"] },
        });
        const begin = fake.rpcCalls[0];
        expect(begin.fn).toBe("begin_tabular_review_generation");
        expect(fake.rpcCalls[1]).toMatchObject({
            fn: "finish_tabular_review_generation",
            args: { target_generation_id: begin.args.target_generation_id },
        });
    });

    it("still releases the lease when the blanking write fails", async () => {
        const fake = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_cells: { data: null, error: { m: "boom" } },
            },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await clearTabularReviewCells(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1"],
            log: LOG,
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
        expect(fake.rpcCalls[1].fn).toBe("finish_tabular_review_generation");
    });

    it("reaps queued jobs before blanking, only in async mode", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        await clearTabularReviewCells(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1"],
            log: LOG,
        });
        expect(removeQueuedExtractionJobs).toHaveBeenCalledWith(
            "rev-1",
            ["row-1"],
            [0],
        );
    });

    it("clears anyway when the queue cannot be reached", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        removeQueuedExtractionJobs.mockRejectedValue(new Error("no redis"));
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await clearTabularReviewCells(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowIds: ["row-1"],
            log: LOG,
        });
        expect(result).toEqual({ ok: true, data: null });
        expect(LOG.error).toHaveBeenCalledWith(
            "[tabular/clear-cells] queue cancellation failed",
            expect.any(Error),
        );
    });
});

describe("regenerateTabularCell", () => {
    const run = (spec = {}) =>
        regenerateTabularCell(makeFakeDb(spec).db, {
            reviewId: "rev-1",
            ...WHO,
            rowId: "row-1",
            columnIndex: 0,
            log: LOG,
        });

    it("400s an unknown column", async () => {
        const result = await regenerateTabularCell(
            makeFakeDb({
                tables: { tabular_reviews: { data: REVIEW, error: null } },
            }).db,
            {
                reviewId: "rev-1",
                ...WHO,
                rowId: "row-1",
                columnIndex: 9,
                log: LOG,
            },
        );
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Column not found",
        });
    });

    it("404s a row whose sources are not all readable", async () => {
        filterAccessibleDocumentIds.mockResolvedValue([]);
        const result = await run({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review row not found",
        });
    });

    it("writes the result guarded by the generation id and releases the lease", async () => {
        queryTabularCell.mockResolvedValue({
            summary: "yes",
            flag: "green",
            reasoning: "",
        });
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await regenerateTabularCell(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowId: "row-1",
            columnIndex: 0,
            log: LOG,
        });
        expect(result).toMatchObject({
            ok: true,
            data: { status: 200, body: { summary: "yes" } },
        });
        const generationId = fake.rpcCalls[0].args.target_generation_id;
        // The stamping write claims the cell; the terminal write is fenced on
        // that stamp so a superseded run can never overwrite the winner.
        expect(callTo(fake.calls, "tabular_cells", 0)).toMatchObject({
            payload: { status: "generating", generation_id: generationId },
        });
        expect(callTo(fake.calls, "tabular_cells", 1)).toMatchObject({
            payload: { status: "done", generation_id: null },
            filters: { generation_id: generationId },
        });
        expect(fake.rpcCalls[1].fn).toBe("finish_tabular_review_generation");
    });

    it("marks the cell errored and 500s when the model returns nothing", async () => {
        queryTabularCell.mockResolvedValue(null);
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await regenerateTabularCell(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowId: "row-1",
            columnIndex: 0,
            log: LOG,
        });
        expect(
            result.ok === false && result.kind === "status" && result.body,
        ).toEqual({ detail: "Generation failed" });
        expect(callTo(fake.calls, "tabular_cells", 1)).toMatchObject({
            payload: { status: "error", generation_id: null },
        });
        expect(fake.rpcCalls[1].fn).toBe("finish_tabular_review_generation");
    });

    it("keeps the lease for the worker once the job is enqueued", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        enqueueExtraction.mockResolvedValue(undefined);
        awaitCellTerminal.mockResolvedValue(null);
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await regenerateTabularCell(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowId: "row-1",
            columnIndex: 0,
            log: LOG,
        });
        expect(result).toMatchObject({
            ok: true,
            data: {
                status: 202,
                body: { status: "generating", detail: "Extraction still running" },
            },
        });
        // Handed off: this request must NOT release a lease the worker holds.
        expect(fake.rpcCalls.map((r) => r.fn)).toEqual([
            "begin_tabular_review_generation",
        ]);
    });

    it("takes the cell terminal itself when the enqueue fails", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        enqueueExtraction.mockRejectedValue(new Error("no redis"));
        const fake = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        const result = await regenerateTabularCell(fake.db, {
            reviewId: "rev-1",
            ...WHO,
            rowId: "row-1",
            columnIndex: 0,
            log: LOG,
        });
        expect(
            result.ok === false && result.kind === "status" && result.body,
        ).toEqual({ detail: "Generation failed" });
        expect(finalizeCell).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: "error" }),
        );
        expect(fake.rpcCalls[1].fn).toBe("finish_tabular_review_generation");
    });

    it("reports a queued job that ended in error as a 500", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        enqueueExtraction.mockResolvedValue(undefined);
        awaitCellTerminal.mockResolvedValue({ status: "error" });
        const result = await run({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
            rpc: (fn: string) =>
                fn === "begin_tabular_review_generation"
                    ? started()
                    : { data: null, error: null },
        });
        expect(
            result.ok === false && result.kind === "status" && result.body,
        ).toEqual({ detail: "Generation failed" });
    });
});
