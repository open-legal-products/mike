import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn() }));
vi.mock("../tabular.extract", () => ({ extractDocumentMarkdown: vi.fn() }));
import { loadReviewRow, loadReviewRows } from "../tabular.rows";

const row = { id: "row", review_id: "review", document_id: "legacy" };
describe("review row loading", () => {
  it("loads exactly one review-scoped row and its ordered sources", async () => {
    const fake = scriptedDb([
      { table: "tabular_review_rows", data: row },
      { table: "tabular_review_row_sources", data: [{ document_id: "second" }, { document_id: "first" }] },
    ]);
    expect(await loadReviewRow(fake.db, "review", "row")).toEqual({ ...row, source_document_ids: ["second", "first"] });
    expect(fake.calls[0].filters).toEqual([["eq", "review_id", "review"], ["eq", "id", "row"]]);
    expect(fake.calls[1].filters).toEqual([["eq", "row_id", "row"], ["order", "sort_index", { ascending: true }]]);
    fake.done();
  });
  it("does not read sources for a missing or cross-review row", async () => {
    const fake = scriptedDb([{ table: "tabular_review_rows", data: null }]);
    expect(await loadReviewRow(fake.db, "other-review", "row")).toBeNull();
    fake.done();
  });
  it("preserves legacy document rows and empty folder rows", async () => {
    for (const document_id of ["legacy", null]) {
      const fake = scriptedDb([{ table: "tabular_review_rows", data: { ...row, document_id } }, { table: "tabular_review_row_sources", data: [] }]);
      expect((await loadReviewRow(fake.db, "review", "row"))?.source_document_ids).toEqual(document_id ? [document_id] : []);
      fake.done();
    }
  });
  it("fails rather than silently dropping sources on query errors", async () => {
    const fake = scriptedDb([{ table: "tabular_review_rows", data: row }, { table: "tabular_review_row_sources", error: { message: "offline" } }]);
    await expect(loadReviewRow(fake.db, "review", "row")).rejects.toThrow("offline");
  });
  it("groups large source lists without copying previously grouped ids", async () => {
    // An iterator counts rereads of the growing bucket. Spreading that bucket
    // per source (the old implementation) turns this from zero into n(n-1)/2.
    const original = Array.prototype[Symbol.iterator];
    let reads = 0;
    // Distinct documents: a (row, document) pair is a primary key.
    const sources = Array.from({ length: 200 }, (_, i) => ({ document_id: `doc-${i}`, row_id: "row", sort_index: i }));
    Array.prototype[Symbol.iterator] = function* (this: unknown[]) {
      for (const value of original.call(this)) {
        if (typeof value === "string" && value.startsWith("doc-")) reads++;
        yield value;
      }
    } as typeof original;
    // Each paged read ends on an empty page.
    const fake = scriptedDb([
      { table: "tabular_review_rows", data: [row] },
      { table: "tabular_review_rows", data: [] },
      { table: "tabular_review_row_sources", data: sources },
      { table: "tabular_review_row_sources", data: [] },
    ]);
    let result;
    try { result = await loadReviewRows(fake.db, "review"); } finally { Array.prototype[Symbol.iterator] = original; }
    expect(result[0].source_document_ids).toHaveLength(200);
    expect(reads).toBe(0);
    fake.done();
  });
  it("takes each source once when offset pages overlap under a concurrent insert", async () => {
    const source = (document_id: string, sort_index: number) => ({ row_id: "row", document_id, sort_index });
    const fake = scriptedDb([
      { table: "tabular_review_rows", data: [row] },
      { table: "tabular_review_rows", data: [] },
      // An insert between the two reads shifted "b" onto the second page too.
      { table: "tabular_review_row_sources", data: [source("a", 0), source("b", 1)] },
      { table: "tabular_review_row_sources", data: [source("b", 1), source("c", 2)] },
      { table: "tabular_review_row_sources", data: [] },
    ]);
    const [loaded] = await loadReviewRows(fake.db, "review");
    expect(loaded.source_document_ids).toEqual(["a", "b", "c"]);
    fake.done();
  });
});
