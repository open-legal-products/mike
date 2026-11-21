import { describe, expect, it } from "vitest";
import { indexReviewCells } from "./reviewCellIndex";
import type { TabularCell } from "../shared/types";

describe("review cell index", () => {
    it("retains first-match semantics and distinguishes row and column ids", () => {
        const first = { row_id: "r", column_index: 3, id: "first" } as TabularCell;
        const second = { ...first, id: "second" };
        const other = { ...first, row_id: "other" };
        const index = indexReviewCells([first, second, other]);
        expect(index.get("r")?.get(3)).toBe(first);
        expect(index.get("other")?.get(3)).toBe(other);
        expect(index.get("r")?.get(4)).toBeUndefined();
    });
    it.each([100, 200, 400])("reads cell identities only linearly for %i rendered slots", (n) => {
        let reads = 0;
        const cells = Array.from({ length: n }, (_, i) => ({
            get row_id() { reads++; return `r${i}`; }, column_index: 0,
        } as TabularCell));
        const index = indexReviewCells(cells);
        for (let i = 0; i < n; i++) expect(index.get(`r${i}`)?.get(0)).toBe(cells[i]);
        expect(reads).toBeLessThanOrEqual(2 * n);
    });
});
