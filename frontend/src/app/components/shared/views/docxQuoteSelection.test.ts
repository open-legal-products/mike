import { describe, expect, it, vi } from "vitest";
import type { TextMatch } from "@docx-editor.dev/core";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { findDocxQuote } from "./docxQuoteSelection";

const row = [
    "P1 — Critical",
    "Complete loss of service or critical function unavailable; major business impact",
    "15 minutes",
    "4 hours",
];

function documentSearch(paragraphs: string[]) {
    const query = vi.fn(() => paragraphs.map((text) => ({ text })));
    const findMatches = vi.fn((text: string): TextMatch[] =>
        paragraphs.flatMap((paragraph, paragraphIndex) => {
            const matches: TextMatch[] = [];
            for (
                let start = paragraph.indexOf(text);
                start !== -1;
                start = paragraph.indexOf(text, start + 1)
            ) {
                matches.push({
                    blockId: `paragraph-${paragraphIndex}`,
                    start,
                    length: text.length,
                    paragraphIndex,
                    runIndex: 0,
                    runOffset: start,
                    text,
                });
            }
            return matches;
        }),
    );
    return { query, findMatches } as unknown as Pick<
        Editor,
        "query" | "findMatches"
    >;
}

function expectRange(
    paragraphs: string[],
    quote: string,
    first: number,
    start: number,
    last: number,
    end: number,
) {
    const match = findDocxQuote(documentSearch(paragraphs), quote);
    expect(match).not.toBeNull();
    expect(match?.start).toMatchObject({
        blockId: `paragraph-${first}`,
        start,
    });
    expect(match?.end.blockId).toBe(`paragraph-${last}`);
    expect(match!.end.start + match!.end.length).toBe(end);
}

describe("findDocxQuote", () => {
    it("matches the entire reported four-cell quote on an unpainted page without paraIds", () => {
        const precedingPages = Array.from(
            { length: 60 },
            (_, i) => `Earlier paragraph ${i}`,
        );
        expectRange(
            [...precedingPages, ...row],
            row.join("\n"),
            60,
            0,
            63,
            row[3].length,
        );
    });

    it("matches flattened citations, wrapped cell text, tabs, and nonbreaking spaces", () => {
        const paragraphs = [
            row[0],
            row[1].replace("service or", "service\n or"),
            "15\u00a0minutes",
            "4\t hours",
        ];
        expectRange(paragraphs, row.join("  "), 0, 0, 3, paragraphs[3].length);
    });

    it("preserves UTF-16 offsets, including partial words and whitespace before endpoints", () => {
        expectRange(
            ["🔴  P1 — Critical", "  4\t hours remaining"],
            "Critical 4 hou",
            0,
            9,
            1,
            8,
        );
    });

    it("includes intervening blank and nested-cell paragraphs in the native range", () => {
        expectRange(
            [row[0], "", row[1], "", row[2], row[3]],
            row.join("\n"),
            0,
            0,
            5,
            row[3].length,
        );
    });

    it("validates all cells rather than landing on an earlier repeated severity or timing", () => {
        expectRange(
            [row[0], "Other service terms", row[2], row[3], ...row],
            row.join("\n"),
            4,
            0,
            7,
            row[3].length,
        );
    });

    it.each([
        [row[0], "Different description", row[2], row[3]],
        [row[0], row[1], "Unrelated intervening text", row[2], row[3]],
        [row[0], row[1], row[2], "8 hours"],
    ])("does not select a partial or discontiguous quote", (...paragraphs) => {
        expect(
            findDocxQuote(documentSearch(paragraphs), row.join("\n")),
        ).toBeNull();
    });

    it("normalizes case without shifting offsets when lowercase would expand a character", () => {
        expectRange(["İ P1", "CRITICAL"], "P1 critical", 0, 2, 1, 8);
    });

    it("retains exact native matches and their model lengths, including fields and other stories", () => {
        const editor = documentSearch([]);
        const exact = {
            blockId: "header",
            start: 4,
            length: 1,
            text: "January 2026",
            scope: { kind: "headerFooter", rId: "header1" },
        };
        vi.mocked(editor.findMatches).mockReturnValue([exact as TextMatch]);
        expect(findDocxQuote(editor, "January 2026")).toEqual({
            start: exact,
            end: exact,
        });
        expect(editor.query).not.toHaveBeenCalled();
    });

    it("ignores header matches with the same paragraph ordinal when mapping body endpoints", () => {
        const editor = documentSearch(row);
        const search = editor.findMatches;
        editor.findMatches = (text, options) =>
            [
                {
                    blockId: "header",
                    start: 0,
                    length: text.length,
                    paragraphIndex: 0,
                    text,
                    scope: { kind: "headerFooter", rId: "header1" },
                } as TextMatch,
                ...search(text, options),
            ].filter(() => !text.includes("\n"));
        expect(findDocxQuote(editor, row.join("\n"))?.start.blockId).toBe(
            "paragraph-0",
        );
    });

    it("rejects empty quotes", () => {
        expect(findDocxQuote(documentSearch(row), " \n ")).toBeNull();
    });
});
