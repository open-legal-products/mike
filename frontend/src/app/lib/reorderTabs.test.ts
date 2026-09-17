import { describe, expect, it } from "vitest";
import { reorderTabs } from "./reorderTabs";

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
const getId = (tab: { id: string }) => tab.id;

describe("reorderTabs", () => {
    it.each([
        ["missing", "b"],
        ["a", "missing"],
        ["a", "a"],
    ])("ignores stale or identical drag targets (%s to %s)", (source, target) => {
        expect(reorderTabs(tabs, source, target, "before", getId)).toBe(tabs);
    });

    it("keeps the original array when a drop preserves the order", () => {
        expect(reorderTabs(tabs, "a", "b", "before", getId)).toBe(tabs);
    });

    it("moves the original tab objects without mutating the source order", () => {
        const result = reorderTabs(tabs, "a", "c", "after", getId);
        expect(result).toEqual([tabs[1], tabs[2], tabs[0]]);
        expect(result[2]).toBe(tabs[0]);
        expect(tabs.map(getId)).toEqual(["a", "b", "c"]);
    });
});
