import { describe, expect, it } from "vitest";
import { restoreOptimisticallyDeletedRows } from "./optimisticRows";

describe("restoreOptimisticallyDeletedRows", () => {
    it("returns current rows unchanged when every deletion succeeded", () => {
        const current = [{ id: "remaining" }];

        expect(restoreOptimisticallyDeletedRows(current, [], [])).toBe(current);
    });

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

    it("emits each id once when the snapshot repeats a row", () => {
        const snapshot = [
            { id: "a", value: 1 },
            { id: "a", value: 1 },
            { id: "b", value: 2 },
        ];

        expect(
            restoreOptimisticallyDeletedRows([snapshot[2]], snapshot, ["a"]),
        ).toEqual([snapshot[0], snapshot[2]]);
    });

    it("emits each id once when a current row repeats a restored row", () => {
        const snapshot = [{ id: "a" }, { id: "b" }];
        const current = [{ id: "b" }, { id: "b" }];

        expect(
            restoreOptimisticallyDeletedRows(current, snapshot, ["a"]),
        ).toEqual([snapshot[0], current[0]]);
    });

    it("preserves rows added after the optimistic removal", () => {
        const snapshot = [{ id: "a" }, { id: "b" }];
        const added = { id: "c" };

        expect(
            restoreOptimisticallyDeletedRows([added], snapshot, ["a"]),
        ).toEqual([snapshot[0], added]);
    });
});
