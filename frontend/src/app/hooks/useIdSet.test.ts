import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useIdSet } from "./useIdSet";

describe("useIdSet", () => {
    it("keeps one Set per selection array and rebuilds it when the array changes", () => {
        const first = ["a", "b"];
        const { result, rerender } = renderHook(({ ids }) => useIdSet(ids), {
            initialProps: { ids: first },
        });
        const initial = result.current;
        expect([...initial]).toEqual(["a", "b"]);
        rerender({ ids: first });
        expect(result.current).toBe(initial);
        rerender({ ids: ["c"] });
        expect([...result.current]).toEqual(["c"]);
    });
});
