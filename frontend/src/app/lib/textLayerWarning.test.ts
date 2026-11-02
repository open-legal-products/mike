import { describe, expect, it } from "vitest";

import { textLayerWarning } from "./textLayerWarning";

describe("textLayerWarning", () => {
    it("says nothing for PDFs with text, non-PDFs and unmeasured versions", () => {
        expect(textLayerWarning(12, 0)).toBeNull();
        expect(textLayerWarning(null, null)).toBeNull();
        expect(textLayerWarning(12, undefined)).toBeNull();
    });

    it("flags a fully scanned PDF", () => {
        expect(textLayerWarning(3, 3)).toMatch(/^No text layer: this PDF looks scanned/);
    });

    it("names the share of pages for a partly scanned PDF", () => {
        expect(textLayerWarning(12, 5)).toBe(
            "5 of 12 pages have no text layer (likely scanned), so the assistant cannot read them.",
        );
    });

    it("uses the singular for one page", () => {
        expect(textLayerWarning(12, 1)).toBe(
            "1 of 12 pages has no text layer (likely scanned), so the assistant cannot read it.",
        );
    });
});
