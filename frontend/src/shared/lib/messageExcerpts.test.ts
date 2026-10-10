import { describe, expect, it } from "vitest";
import {
    MAX_EXCERPT_LENGTH,
    normalizeExcerptNote,
    normalizeExcerptText,
    parseExcerpts,
    serializeExcerpts,
} from "./messageExcerpts";

describe("messageExcerpts", () => {
    it("quotes excerpts above the message and reads them back", () => {
        const excerpts = [
            { text: "The notice period is 30 days." },
            {
                text: "First paragraph.\n\nSecond paragraph.",
                note: "Is this enforceable?",
            },
        ];
        const content = serializeExcerpts(excerpts, "Explain both.");

        expect(content).toBe(
            [
                "> The notice period is 30 days.",
                "",
                "> First paragraph.",
                ">",
                "> Second paragraph.",
                "Note: Is this enforceable?",
                "",
                "Explain both.",
            ].join("\n"),
        );
        expect(parseExcerpts(content)).toEqual({
            excerpts,
            body: "Explain both.",
        });
    });

    it("sends annotated excerpts on their own when there is no message", () => {
        const excerpts = [{ text: "Clause 4", note: "Why?" }];
        const content = serializeExcerpts(excerpts, "");

        expect(content).toBe("> Clause 4\nNote: Why?");
        expect(parseExcerpts(content)).toEqual({ excerpts, body: "" });
    });

    it("leaves a message without a leading quote alone", () => {
        const content = "Compare this:\n> quoted later\nwith that.";
        expect(parseExcerpts(content)).toEqual({ excerpts: [], body: content });
    });

    it("treats a quote that runs straight into prose as the writer's own", () => {
        const content = "> quoted\nand then prose";
        expect(parseExcerpts(content)).toEqual({ excerpts: [], body: content });
    });

    it("keeps a multi-line body intact", () => {
        const content = serializeExcerpts(
            [{ text: "Quoted" }],
            "Line one\n\nLine two",
        );
        expect(parseExcerpts(content).body).toBe("Line one\n\nLine two");
    });

    it("normalizes selected text and notes", () => {
        expect(normalizeExcerptText("  one  \r\n\n\n\ntwo \n")).toBe(
            "one\n\ntwo",
        );
        expect(normalizeExcerptNote("  why\n  this? ")).toBe("why this?");
    });

    it("caps a very long excerpt", () => {
        const text = normalizeExcerptText("a".repeat(MAX_EXCERPT_LENGTH + 50));
        expect(text).toHaveLength(MAX_EXCERPT_LENGTH + 1);
        expect(text.endsWith("…")).toBe(true);
    });
});
