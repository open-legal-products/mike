import { describe, expect, it } from "vitest";
import { parsedTime, sortByNewest } from "./sortByNewest";

describe("sortByNewest", () => {
    it("orders newest first, then by the tie-break, then by input order", () => {
        const items = [
            { id: "b", at: 1 }, { id: "a", at: 1 }, { id: "c", at: 3 }, { id: "d", at: 0 },
        ];
        expect(sortByNewest(items, (i) => i.at).map((i) => i.id)).toEqual(["c", "b", "a", "d"]);
        expect(sortByNewest(items, (i) => i.at, (l, r) => l.id.localeCompare(r.id)).map((i) => i.id))
            .toEqual(["c", "a", "b", "d"]);
        expect(parsedTime(undefined)).toBe(0);
        expect(parsedTime("not a date")).toBe(0);
    });

    it.each([200, 800])("computes each of %i times once", (n) => {
        let parses = 0;
        const items = Array.from({ length: n }, (_, i) => ({ at: (i * 7919) % n }));
        sortByNewest(items, (item) => { parses++; return item.at; });
        expect(parses).toBe(n);
    });
});
