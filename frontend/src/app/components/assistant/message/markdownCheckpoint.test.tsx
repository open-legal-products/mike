import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIVE_MARKDOWN_LIMIT, useMarkdownCheckpoint } from "./markdownCheckpoint";

describe("streamed Markdown parser checkpoints", () => {
    it.each([32768, 65536, 131072])("bounds rich-parser input as a live block grows to %i characters", length => {
        const {result, rerender} = renderHook(({text, streaming}) => useMarkdownCheckpoint(text, streaming), {initialProps: {text: "x".repeat(LIVE_MARKDOWN_LIMIT), streaming: true}});
        let prior = result.current.richText;
        let parsedCharacters = prior.length;
        for (let size = LIVE_MARKDOWN_LIMIT + 32; size <= length; size += 32) {
            const text = "x".repeat(size);
            rerender({text, streaming: true});
            expect(result.current.richText + result.current.plainTail).toBe(text);
            if (result.current.richText !== prior) parsedCharacters += result.current.richText.length;
            prior = result.current.richText;
        }
        // Geometric growth sums to a constant multiple of the final input,
        // unlike reparsing all prefixes (which sums to a quadratic amount).
        expect(parsedCharacters).toBeLessThan(length * 6);
        rerender({text: "x".repeat(length), streaming: false});
        expect(result.current).toEqual({richText: "x".repeat(length), plainTail: ""});
    });
    it("flushes rewrites, short responses and tool/completion boundaries", () => {
        const {result, rerender} = renderHook(({text, streaming}) => useMarkdownCheckpoint(text, streaming), {initialProps: {text: "short", streaming: true}});
        rerender({text: "short **answer**", streaming: true});
        expect(result.current.plainTail).toBe("");
        rerender({text: "x".repeat(9000), streaming: true});
        rerender({text: "x".repeat(9000) + "<script>alert(1)</script>", streaming: true});
        expect(result.current.plainTail).toBe("<script>alert(1)</script>");
        rerender({text: "replacement", streaming: true});
        expect(result.current).toEqual({richText: "replacement", plainTail: ""});
    });
});
