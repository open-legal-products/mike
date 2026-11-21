import { describe, expect, it } from "vitest";
import { appendMissingById, missingById } from "./idCollections";

const item = (id: string, label = id) => ({ id, label });

describe("id collections", () => {
    it("appends only unseen ids, in order, and keeps the array when nothing is new", () => {
        const existing = [item("a"), item("b")];
        expect(appendMissingById(existing, [item("b", "new b"), item("c"), item("c"), item("d")]))
            .toEqual([item("a"), item("b"), item("c"), item("d")]);
        expect(appendMissingById(existing, [item("a")])).toBe(existing);
        expect(missingById([item("x")], [item("x"), item("y")])).toEqual([item("y")]);
    });

    it.each([100, 200, 400])("reads each of %i existing and incoming ids a bounded number of times", (n) => {
        let reads = 0;
        const counted = (id: string) => ({ get id() { reads++; return id; } });
        const existing = Array.from({ length: n }, (_, i) => counted(`e${i}`));
        const incoming = Array.from({ length: n }, (_, i) => counted(`i${i}`));
        expect(appendMissingById(existing, incoming)).toHaveLength(2 * n);
        expect(reads).toBeLessThanOrEqual(4 * n);
    });
});
