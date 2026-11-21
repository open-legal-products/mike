import type { HighlightRange, TextMatch } from "@docx-editor.dev/core";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { foldCase } from "@docx-editor.dev/core/store";

type QuoteSearch = Pick<Editor, "findMatches" | "query">;

export interface DocxQuoteMatch {
    start: TextMatch;
    end: TextMatch;
    /** The quote as one range per paragraph it covers, in document order. */
    ranges: HighlightRange[];
}

/** Find the whole quote before selecting anything, including across table cells.
 * Paragraph queries include unpainted pages and nested tables in document order.
 * Keep punctuation intact; only whitespace and case may differ from the citation.
 */
export function findDocxQuote(
    editor: QuoteSearch,
    quote: string,
): DocxQuoteMatch | null {
    if (!quote.trim()) return null;
    const exact = editor.findMatches(quote)[0];
    if (exact) return { start: exact, end: exact, ranges: [exact] };

    const words: {
        text: string;
        paragraphIndex: number;
        offset: number;
        start: number;
    }[] = [];
    let length = 0;
    editor
        .query({ type: "paragraphs", container: { part: "body" } })
        .forEach((paragraph, paragraphIndex) => {
            for (const word of paragraph.text.matchAll(/\S+/gu)) {
                words.push({
                    text: word[0],
                    paragraphIndex,
                    offset: word.index,
                    start: length,
                });
                length += word[0].length + 1;
            }
        });
    const text = foldCase(words.map((word) => word.text).join(" "));
    const needle = foldCase(quote.trim().replace(/\s+/gu, " "));

    // Recover native model addresses from endpoint searches. Files need not have
    // w14:paraId attributes, and rendered DOM pages may not exist yet.
    const endpoint = (
        position: number,
        end: boolean,
    ): TextMatch | undefined => {
        const word = words.find(
            (entry) =>
                position >= entry.start &&
                position < entry.start + entry.text.length,
        );
        if (!word) return undefined;
        const offset = position - word.start;
        const fragment = end
            ? word.text.slice(0, offset + 1)
            : word.text.slice(offset);
        const sourceOffset = word.offset + (end ? 0 : offset);
        return editor
            .findMatches(fragment, { matchCase: true })
            .find(
                (match) =>
                    (!match.scope || match.scope.kind === "body") &&
                    match.paragraphIndex === word.paragraphIndex &&
                    match.start === sourceOffset,
            );
    };
    // One range per covered paragraph. Each paragraph's address is recovered
    // like an endpoint, from its first covered character.
    const paragraphRanges = (index: number): HighlightRange[] | null => {
        const last = index + needle.length;
        const covered = words.filter(
            (word) => word.start < last && word.start + word.text.length > index,
        );
        const ranges: HighlightRange[] = [];
        for (let i = 0; i < covered.length; i++) {
            const word = covered[i];
            const end =
                word.offset + Math.min(word.text.length, last - word.start);
            if (covered[i - 1]?.paragraphIndex === word.paragraphIndex) {
                const current = ranges[ranges.length - 1];
                ranges[ranges.length - 1] = {
                    ...current,
                    length: end - current.start,
                };
                continue;
            }
            const first = endpoint(Math.max(index, word.start), false);
            if (!first) return null;
            ranges.push({
                blockId: first.blockId,
                start: first.start,
                length: end - first.start,
                scope: first.scope,
            });
        }
        return ranges;
    };
    for (
        let index = text.indexOf(needle);
        index !== -1;
        index = text.indexOf(needle, index + 1)
    ) {
        const start = endpoint(index, false);
        const end = endpoint(index + needle.length - 1, true);
        const ranges = start && end ? paragraphRanges(index) : null;
        if (start && end && ranges) return { start, end, ranges };
    }
    return null;
}
