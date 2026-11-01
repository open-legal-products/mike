import { describe, expect, it } from "vitest";
import { reviewRowRemoval } from "./reviewRowRemoval";
import type { TabularCell, TabularReviewRow } from "../shared/types";
import { countIndexReads } from "@/app/__tests__/countIndexReads";

const row = (id: string, docs: string[] = [`d-${id}`]) =>
    ({ id, source_document_ids: docs }) as TabularReviewRow;
const cell = (rowId: string, column: number) =>
    ({ id: `${rowId}:${column}`, row_id: rowId, column_index: column }) as TabularCell;

describe("review row removal", () => {
    it("takes out exactly the removed rows, their documents and cells", () => {
        const rows = [row("a", ["d1", "d2"]), row("b"), row("c", ["d1"])];
        const cells = [cell("a", 0), cell("b", 0), cell("c", 1), cell("a", 1)];
        const removal = reviewRowRemoval(["a", "c"]);
        expect([...removal.documentIds(rows)]).toEqual(["d1", "d2"]);
        expect(rows.filter(removal.keepsRow).map((r) => r.id)).toEqual(["b"]);
        expect(cells.filter(removal.keepsCell).map((c) => c.id)).toEqual(["b:0"]);
        expect(removal.cellIds(cells)).toEqual(["a:0", "c:1", "a:1"]);
    });

    it.each([100, 200, 400])(
        "reads the %i removed ids once, not once per row and cell",
        (n) => {
            const ids = Array.from({ length: n }, (_, i) => `r${i}`);
            const rows = ids.map((id) => row(id));
            const cells = ids.flatMap((id) => [cell(id, 0), cell(id, 1)]);
            const { proxy, reads } = countIndexReads(ids);
            const removal = reviewRowRemoval(proxy);
            removal.documentIds(rows);
            expect(rows.filter(removal.keepsRow)).toEqual([]);
            expect(cells.filter(removal.keepsCell)).toEqual([]);
            expect(removal.cellIds(cells)).toHaveLength(2 * n);
            expect(reads.count).toBeLessThanOrEqual(n);
        },
    );
});
