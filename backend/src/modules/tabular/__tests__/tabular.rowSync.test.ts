import { describe, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureReviewAccess: vi.fn(async () => ({ ok: true, isCreator: true, projectRole: "owner" })),
  filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
}));
vi.mock("../../../lib/documentWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentWorkspace")>()),
  findDocumentsOutsideWorkspace: vi.fn(async () => []),
}));
vi.mock("../../../lib/personalOrgs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/personalOrgs")>()),
  teamOrgIdOf: vi.fn(async () => null),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
import { updateTabularReview } from "../tabular.reviews";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${String(i).padStart(2, "0")}`);

describe("changing a review's document set", () => {
  it("keeps every unaffected row (and so its finished cells) when one document is added", async () => {
    const existing = ids(10);
    const fake = tableDb({
      tabular_reviews: [{
        id: "rev", user_id: "u", project_id: null, org_id: null, document_grouping: "document",
        document_ids: existing, columns_config: [{ index: 0, name: "A", prompt: "a" }],
      }],
      documents: ids(11).map((id) => ({ id, current_version_id: `v-${id}`, project_id: null })),
      document_versions: ids(11).map((id) => ({ id: `v-${id}`, filename: `${id}.pdf`, deleted_at: null })),
      tabular_review_rows: existing.map((id, i) => ({
        id: `row-${id}`, review_id: "rev", label: `${id}.pdf`, row_type: "document",
        folder_id: null, library_folder_id: null, document_id: id, sort_index: i,
      })),
      tabular_review_row_sources: existing.map((id) => ({ row_id: `row-${id}`, document_id: id, sort_index: 0 })),
      tabular_cells: existing.map((id) => ({ id: `cell-${id}`, review_id: "rev", row_id: `row-${id}`, column_index: 0, status: "done" })),
    });
    const result = await updateTabularReview(fake.db, {
      reviewId: "rev", userId: "u", userEmail: "u@example.com", body: { document_ids: ids(11) },
    });
    expect(result.ok).toBe(true);
    const rows = fake.tables.tabular_review_rows as { id: string; label: string; sort_index: number }[];
    // Deleting a row cascades to its cells: every original row must survive.
    expect(existing.filter((id) => !rows.some((row) => row.id === `row-${id}`))).toEqual([]);
    expect(rows.map((row) => [row.label, row.sort_index]).sort((a, b) => Number(a[1]) - Number(b[1])))
      .toEqual(ids(11).map((id, i) => [`${id}.pdf`, i]));
    expect(fake.tables.tabular_cells.filter((cell) => cell.status === "pending")).toHaveLength(1);
  });

  it("rebuilds only the folder rows whose membership changed", async () => {
    const folderOf: Record<string, string> = { d00: "f1", d01: "f1", d02: "f2", d03: "f3" };
    const fake = tableDb({
      tabular_reviews: [{
        id: "rev", user_id: "u", project_id: "p", org_id: null, document_grouping: "folder",
        document_ids: ["d00", "d01", "d02"], columns_config: [{ index: 0, name: "A", prompt: "a" }],
      }],
      documents: Object.entries(folderOf).map(([id, folder_id]) => ({ id, current_version_id: null, project_id: "p", folder_id })),
      project_subfolders: ["f1", "f2", "f3"].map((id) => ({ id, name: id.toUpperCase(), parent_folder_id: null, project_id: "p" })),
      tabular_review_rows: ["f1", "f2"].map((f, i) => ({
        id: `row-${f}`, review_id: "rev", label: f.toUpperCase(), row_type: "folder",
        folder_id: f, library_folder_id: null, document_id: null, sort_index: i,
      })),
      tabular_review_row_sources: ["d00", "d01", "d02"].map((id) => ({ row_id: `row-${folderOf[id]}`, document_id: id, sort_index: 0 })),
      tabular_cells: [],
    });
    const result = await updateTabularReview(fake.db, {
      reviewId: "rev", userId: "u", userEmail: "u@example.com", body: { document_ids: ["d00", "d02", "d03"] },
    });
    expect(result.ok).toBe(true);
    const rows = fake.tables.tabular_review_rows as { id: string; label: string; sort_index: number }[];
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(Object.keys(byLabel).sort()).toEqual(["F1", "F2", "F3"]);
    expect(byLabel.F2.id).toBe("row-f2");
    expect(byLabel.F1.id).not.toBe("row-f1");
    expect(fake.tables.tabular_review_row_sources.filter((src) => src.row_id === byLabel.F1.id).map((src) => src.document_id)).toEqual(["d00"]);
    expect(rows.map((row) => row.sort_index).sort()).toEqual([0, 1, 2]);
  });
});
