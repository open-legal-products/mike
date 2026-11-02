import type { TextMatch } from "@docx-editor.dev/core";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { foldCase } from "@docx-editor.dev/core/store";

type QuoteSearch = Pick<Editor, "findMatches" | "query">;

export interface DocxQuoteMatch {
    start: TextMatch;
    end: TextMatch;
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
    if (exact) return { start: exact, end: exact };

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
    for (
        let index = text.indexOf(needle);
        index !== -1;
        index = text.indexOf(needle, index + 1)
    ) {
        const start = endpoint(index, false);
        const end = endpoint(index + needle.length - 1, true);
        if (start && end) return { start, end };
    }
    return null;
}
