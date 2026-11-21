import { describe, expect, it } from "vitest";
import { createPdfQuoteMatcher, normalizePdfQuoteText } from "./pdfQuoteSearch";
describe("batched PDF quote search", () => {
    it("handles overlapping prefixes, duplicate quotes, segments and first-page preference", () => {
        const matcher = createPdfQuoteMatcher(["she", "he", "she", "absent…hers", "never"]);
        matcher.scan(normalizePdfQuoteText("She is here, hers."), 2);
        matcher.scan("she", 3);
        expect([...matcher.pages]).toEqual([[0,2],[2,2],[1,2],[3,2]]);
    });
    it.each([100,200,400])("scans a page once for %i missing quotes", n => {
        const matcher = createPdfQuoteMatcher(Array.from({length:n}, (_,i) => `missing${i}`));
        let reads = 0;
        const text = { *[Symbol.iterator]() { for (let i=0; i<1000; i++) {reads++; yield "a";} } } as unknown as string;
        matcher.scan(text, 1);
        expect(reads).toBe(1000);
        expect(matcher.pages.size).toBe(0);
    });
});
