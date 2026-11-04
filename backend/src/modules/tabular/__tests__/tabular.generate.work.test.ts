import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureReviewAccess, filterAccessibleDocumentIds, loadReviewRows, validateSelectedModel } = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    loadReviewRows: vi.fn(),
    validateSelectedModel: vi.fn(),
}));
vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureReviewAccess,
    filterAccessibleDocumentIds,
}));
vi.mock("../tabular.rows", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.rows")>()),
    loadReviewRows,
}));
vi.mock("../tabular.shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.shared")>()),
    validateSelectedModel,
}));

import { loadTabularGenerateWork, prepareTabularRunView } from "../tabular.generate";
import { makeFakeDb } from "./fakeDb";

const ARGS = { reviewId: "rev-1", userId: "user-1", userEmail: "me@example.com" };
const ROW = {
    id: "row-1", review_id: "rev-1", label: "Contract.pdf", row_type: "document",
    document_id: "doc-1", source_document_ids: ["doc-1"], sort_index: 0,
};

beforeEach(() => {
    vi.resetAllMocks();
    loadReviewRows.mockResolvedValue([ROW]);
    filterAccessibleDocumentIds.mockResolvedValue(["doc-1"]);
    ensureReviewAccess.mockResolvedValue({ ok: true, projectRole: "owner" });
    validateSelectedModel.mockResolvedValue({ ok: true, model: "claude-sonnet-5", apiKeys: {} });
});

describe("tabular generation work access failures", () => {
    it.each([loadTabularGenerateWork, prepareTabularRunView])("returns an internal failure from %s instead of rejecting", async prepare => {
        const error = new Error("Document access lookup failed");
        filterAccessibleDocumentIds.mockRejectedValueOnce(error);
        const fake = makeFakeDb({ tables: {
            tabular_reviews: { data: {
                id: "rev-1", columns_config: [{ index: 0, name: "A", prompt: "a" }],
            }, error: null },
            tabular_cells: { data: [], error: null },
        } });
        await expect(prepare(fake.db, ARGS)).resolves.toEqual({ ok: false, kind: "error", error });
        expect(fake.calls.every(call => call.op === "select")).toBe(true);
    });

    it("still filters genuine access denials without treating them as database failures", async () => {
        filterAccessibleDocumentIds.mockResolvedValueOnce([]);
        const { db } = makeFakeDb();
        await expect(loadTabularGenerateWork(db, ARGS)).resolves.toEqual({
            ok: true, data: { rows: [], cellMap: new Map() },
        });
    });

    it("retains the existing cell-query failure variant", async () => {
        const error = { message: "Cells unavailable" };
        const { db } = makeFakeDb({ tables: { tabular_cells: { data: null, error } } });
        await expect(loadTabularGenerateWork(db, ARGS)).resolves.toEqual({
            ok: false, kind: "cells_error", error,
        });
    });
});
