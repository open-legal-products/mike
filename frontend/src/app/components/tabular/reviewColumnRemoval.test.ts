import { describe, expect, it } from "vitest";
import { reviewColumnRemoval } from "./reviewColumnRemoval";
import { countIndexReads } from "@/app/__tests__/countIndexReads";

describe("review column removal", () => {
    it("drops exactly the removed columns and their cells", () => {
        const removal = reviewColumnRemoval([2, 4]);
        const columns = [0, 2, 3, 4].map((index) => ({ index }));
        const cells = [0, 2, 3, 4, 2].map((column_index) => ({ column_index }));
        expect(columns.filter(removal.keepsColumn)).toEqual([{ index: 0 }, { index: 3 }]);
        expect(cells.filter(removal.keepsCell)).toEqual([{ column_index: 0 }, { column_index: 3 }]);
    });

    it.each([10, 20])("reads the %i removed columns once, not once per cell", (k) => {
        const indexes = Array.from({ length: k }, (_, i) => 100 + i);
        const { proxy, reads } = countIndexReads(indexes);
        const removal = reviewColumnRemoval(proxy);
        const cells = Array.from({ length: 1_000 }, (_, i) => ({ column_index: i % 30 }));
        expect(cells.filter(removal.keepsCell)).toHaveLength(1_000);
        expect(reads.count).toBeLessThanOrEqual(k);
    });
});
