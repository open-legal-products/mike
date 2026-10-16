import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestRef } from "./useLatestRef";

describe("useLatestRef", () => {
    it("returns one stable ref that tracks the latest render's value", () => {
        const { result, rerender } = renderHook(
            ({ value }) => useLatestRef(value),
            { initialProps: { value: (): string => "first" } },
        );
        const ref = result.current;
        // A retry captured after the first render...
        const retry = () => ref.current();

        rerender({ value: () => "second" });

        // ...runs the closure from the latest render, not the one it saw.
        expect(result.current).toBe(ref);
        expect(retry()).toBe("second");
    });
});
