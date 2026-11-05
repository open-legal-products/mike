import { describe, expect, it, vi } from "vitest";
import { createCitationPreprocessor } from "./citationPreprocessor";

describe("completed citation projection reuse", () => {
    it("reuses stable blocks while invalidating annotations and token offsets", () => {
        const annotations = [{id: 1}];
        const project = vi.fn((text: string, input: typeof annotations, targets: typeof annotations) => {
            const offset = targets.length;
            targets.push(...input);
            return `${text}:${offset}:${input[0].id}`;
        });
        const process = createCitationPreprocessor(project);
        for (let tick = 0; tick < 100; tick++) {
            const targets: typeof annotations = [];
            expect(process(0, "old", annotations, targets)).toBe("old:0:1");
            expect(process(1, "live" + tick, annotations, targets)).toBe(`live${tick}:1:1`);
            expect(targets).toEqual([...annotations, ...annotations]);
        }
        expect(project).toHaveBeenCalledTimes(101);
        expect(process(0, "old", [{id: 2}], [])).toBe("old:0:2");
        expect(process(0, "old", annotations, [{id: 3}])).toBe("old:1:1");
    });
});
