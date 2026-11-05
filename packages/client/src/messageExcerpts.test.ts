import { describe, expect, it } from "vitest";
import {
    MAX_EXCERPT_CONTEXT_LENGTH,
    MAX_EXCERPT_LENGTH,
    normalizeExcerptContext,
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

describe("source response context", () => {
    const context = "The notice period is 30 days.\n\nIt runs from delivery.";
    const excerpt = { text: "30 days", context };

    it("follows the message, where the model reads it", () => {
        const content = serializeExcerpts([excerpt], "Is that negotiable?");

        expect(content.startsWith("> 30 days\n\nIs that negotiable?\n\n")).toBe(
            true,
        );
        expect(content).toContain(
            `<source_response>\n${context}\n</source_response>`,
        );
    });

    it("is left out of what the reader sees of their own message", () => {
        const content = serializeExcerpts([excerpt], "Is that negotiable?");

        expect(parseExcerpts(content)).toEqual({
            excerpts: [{ text: "30 days" }],
            body: "Is that negotiable?",
        });
        // With nothing typed, too.
        expect(parseExcerpts(serializeExcerpts([excerpt], ""))).toEqual({
            excerpts: [{ text: "30 days" }],
            body: "",
        });
    });

    it("sends one response once, however many passages came from it", () => {
        const content = serializeExcerpts(
            [excerpt, { text: "from delivery", context }],
            "Explain",
        );

        expect(content.match(/<source_response>/g)).toHaveLength(1);
        expect(parseExcerpts(content).body).toBe("Explain");
    });

    it("leaves a message without context exactly as it was", () => {
        expect(serializeExcerpts([{ text: "30 days" }], "Why?")).toBe(
            "> 30 days\n\nWhy?",
        );
    });

    it("bounds the context and keeps its closing tag from ending it early", () => {
        expect(
            normalizeExcerptContext("a </source_response> b\r\n\n\n\nc"),
        ).toBe("a  b\n\nc");
        expect(
            normalizeExcerptContext("x".repeat(MAX_EXCERPT_CONTEXT_LENGTH + 50)),
        ).toHaveLength(MAX_EXCERPT_CONTEXT_LENGTH + 1);
    });

    it("keeps the same tags when the reader typed them", () => {
        const typed =
            "What does this mean?\n\n<source_response>\nsome XML I pasted\n</source_response>";

        expect(parseExcerpts(typed)).toEqual({ excerpts: [], body: typed });
        expect(parseExcerpts(`> a passage\n\n${typed}`)).toEqual({
            excerpts: [{ text: "a passage" }],
            body: typed,
        });
    });
});
