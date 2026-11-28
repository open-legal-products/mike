import { describe, expect, it } from "vitest";
import { preprocessCitations } from "./citationUtils";

const cited = (...refs: number[]) => refs.map((ref) => ({ ref }));

describe("preprocessCitations", () => {
    it("turns each cited marker into a citation token", () => {
        const targets: { ref: number }[] = [];
        expect(preprocessCitations("A [1]. B [1, 2].", cited(1, 2), targets)).toBe(
            "A `§0§`​. B `§1§`​`§2§`​.",
        );
        expect(targets.map((target) => target.ref)).toEqual([1, 1, 2]);
    });

    it("leaves a group with no cited ref as written", () => {
        const targets: { ref: number }[] = [];
        expect(preprocessCitations("As held at [45] and [12, 13].", cited(1), targets)).toBe(
            "As held at [45] and [12, 13].",
        );
        expect(targets).toEqual([]);
    });

    it("keeps an uncited ref of a partly cited group as text in its place", () => {
        const targets: { ref: number }[] = [];
        expect(preprocessCitations("See [45, 1, 46].", cited(1), targets)).toBe(
            "See [45]`§0§`​[46].",
        );
        expect(targets.map((target) => target.ref)).toEqual([1]);
    });
});
