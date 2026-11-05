import { describe, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn() }));
vi.mock("../tabular.extract", () => ({ extractDocumentMarkdown: vi.fn() }));
import { loadTabularGenerateWork } from "../tabular.generate";

describe("whole-review reads past PostgREST max_rows", () => {
  it("sees every row and existing cell of a 100-row x 15-column review", async () => {
    const rows = Array.from({ length: 100 }, (_, r) => ({
      id: `row-${String(r).padStart(3, "0")}`, review_id: "rev", row_type: "folder",
      document_id: null, sort_index: r,
    }));
    const cells = rows.flatMap((row, r) => Array.from({ length: 15 }, (_, c) => ({
      id: `cell-${String(r * 15 + c).padStart(5, "0")}`, review_id: "rev", row_id: row.id,
      column_index: c, status: "done", content: "x",
    })));
    const fake = tableDb({ tabular_review_rows: rows, tabular_cells: cells, tabular_review_row_sources: [] });
    const work = await loadTabularGenerateWork(fake.db, { reviewId: "rev", userId: "u", userEmail: undefined });
    expect(work.ok && work.data.rows.length).toBe(100);
    // Truncated at 1000, generation would treat 500 finished cells as missing.
    expect(work.ok && work.data.cellMap.size).toBe(1500);
  });
});
