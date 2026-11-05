import { describe, expect, it } from "vitest";
import { nextRevealLength } from "./tabularReveal";

describe("tabular response reveal", () => {
    it.each([10000, 100000, 1000000])("drains a %i-character backlog in bounded frames without skipping text", target => {
        let displayed = 0;
        let frames = 0;
        while (displayed < target) {
            const next = nextRevealLength(displayed, target);
            expect(next).toBeGreaterThan(displayed);
            expect(next).toBeLessThanOrEqual(target);
            displayed = next;
            frames++;
        }
        expect(frames).toBeLessThan(250);
    });
    it("retains smooth small increments and exact final boundaries", () => {
        expect(nextRevealLength(0, 10)).toBe(8);
        expect(nextRevealLength(8, 10)).toBe(10);
        expect(nextRevealLength(10, 10)).toBe(10);
    });
});
