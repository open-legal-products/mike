import { describe, expect, it } from "vitest";
import { restoreOptimisticallyDeletedRows } from "./optimisticRows";

describe("restoreOptimisticallyDeletedRows", () => {
    it("restores only failed rows in their original order", () => {
        const snapshot = [
            { id: "a", value: 1 },
            { id: "b", value: 2 },
            { id: "c", value: 3 },
        ];

        expect(
            restoreOptimisticallyDeletedRows([snapshot[2]], snapshot, ["b"]),
        ).toEqual([snapshot[1], snapshot[2]]);
    });

    it("preserves rows added after the optimistic removal", () => {
        const snapshot = [{ id: "a" }, { id: "b" }];
        const added = { id: "c" };

        expect(
            restoreOptimisticallyDeletedRows([added], snapshot, ["a"]),
        ).toEqual([snapshot[0], added]);
    });
});
