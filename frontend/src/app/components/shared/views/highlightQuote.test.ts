import { describe, expect, it, vi } from "vitest";
import { highlightQuote } from "./highlightQuote";

const HIGHLIGHT = ".pdf-text-highlight";

/**
 * A two-column table whose content stream draws the whole left column before
 * the right one, which is how generators commonly emit tables. `textDivs`
 * therefore arrives in drawing order, while the backend extractor hands the
 * model the same cells in reading order ("Alice   $100" on one row).
 */
function columnDrawnTable() {
    const container = document.createElement("div");
    const textDivs = ["Name", "Alice", "Bob", "Amount", "$100", "$200"].map(
        (text) => {
            const span = document.createElement("span");
            span.textContent = text;
            container.appendChild(span);
            return span;
        },
    );
    // Reading order interleaves the columns: Name, Amount, Alice, $100, ...
    return { container, textDivs, readingOrder: [0, 3, 1, 4, 2, 5] };
}

function highlighted(container: HTMLElement): string[] {
    return [...container.querySelectorAll(HIGHLIGHT)].map(
        (node) => node.textContent ?? "",
    );
}

describe("highlightQuote", () => {
    it("finds a quote that reads across a column-drawn table row", async () => {
        const { container, textDivs, readingOrder } = columnDrawnTable();

        const found = await highlightQuote(textDivs, "Alice $100", readingOrder);

        expect(found).toBe(true);
        expect(highlighted(container)).toEqual(["Alice", "100"]);
    });

    it("cannot find that quote in drawing order", async () => {
        // Guards the regression itself: without a reading order the quote's
        // characters are not contiguous, so the substring search misses and the
        // citation silently fails to highlight.
        const { container, textDivs } = columnDrawnTable();

        const found = await highlightQuote(textDivs, "Alice $100");

        expect(found).toBe(false);
        expect(highlighted(container)).toEqual([]);
    });

    it("still matches single-column text without a reading order", async () => {
        const container = document.createElement("div");
        const textDivs = ["The quick ", "brown fox"].map((text) => {
            const span = document.createElement("span");
            span.textContent = text;
            container.appendChild(span);
            return span;
        });

        const found = await highlightQuote(textDivs, "quick brown");

        expect(found).toBe(true);
        // Trailing whitespace rides along: the match is computed on stripped
        // text, and the end position maps back past the space.
        expect(highlighted(container)).toEqual(["quick ", "brown "]);
    });

    it("normalizes immutable page spans once across repeated quote focuses", async () => {
        const {textDivs, readingOrder} = columnDrawnTable();
        const reads = textDivs.map(div => vi.spyOn(div, "textContent", "get"));
        await highlightQuote(textDivs, "Alice $100", readingOrder);
        reads.forEach(read => read.mockClear());
        await highlightQuote(textDivs, "Bob $200", readingOrder);
        expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
        reads.forEach(read => read.mockRestore());
    });

    it("clears previous highlights before matching again", async () => {
        const { container, textDivs, readingOrder } = columnDrawnTable();

        await highlightQuote(textDivs, "Alice $100", readingOrder);
        await highlightQuote(textDivs, "Bob $200", readingOrder);

        expect(highlighted(container)).toEqual(["Bob", "200"]);
    });
});
