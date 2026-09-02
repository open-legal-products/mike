import { describe, expect, it } from "vitest";
import {
    buildQuotedMessageContent,
    capExcerpt,
    hasQuotedExcerpts,
    MAX_QUOTED_EXCERPT_CHARS,
    normalizeExcerpt,
    parseQuotedMessageContent,
    prepareExcerpt,
    QUOTED_EXCERPT_PREFACE,
} from "./quotedExcerpts";

describe("normalizeExcerpt", () => {
    it("collapses whitespace runs and trims", () => {
        expect(normalizeExcerpt("  the   quick\n\tbrown  fox \n")).toBe(
            "the quick brown fox",
        );
    });

    it("returns an empty string for whitespace-only input", () => {
        expect(normalizeExcerpt("   \n\t  ")).toBe("");
    });

    it("leaves already-tidy text alone", () => {
        expect(normalizeExcerpt("clause 4.2 applies")).toBe(
            "clause 4.2 applies",
        );
    });
});

describe("capExcerpt", () => {
    it("passes short text through untouched", () => {
        expect(capExcerpt("short")).toEqual({
            text: "short",
            truncated: false,
        });
    });

    it("passes text exactly at the cap through untouched", () => {
        const exact = "x".repeat(MAX_QUOTED_EXCERPT_CHARS);
        expect(capExcerpt(exact)).toEqual({ text: exact, truncated: false });
    });

    it("cuts back to a word boundary when one is near the cap", () => {
        // A space just past 90% of the cap is a good place to break.
        const head = "word ".repeat(MAX_QUOTED_EXCERPT_CHARS / 5 + 10);
        const result = capExcerpt(head);
        expect(result.truncated).toBe(true);
        expect(result.text.endsWith("…")).toBe(true);
        expect(result.text.endsWith("word…")).toBe(true);
        expect(result.text.length).toBeLessThanOrEqual(
            MAX_QUOTED_EXCERPT_CHARS + 1,
        );
    });

    it("hard-cuts when the only space is far before the cap", () => {
        const text = `a ${"b".repeat(MAX_QUOTED_EXCERPT_CHARS)}`;
        const result = capExcerpt(text);
        expect(result.truncated).toBe(true);
        // The word boundary at index 1 would throw away the whole excerpt, so
        // the hard cut wins.
        expect(result.text.length).toBe(MAX_QUOTED_EXCERPT_CHARS + 1);
        expect(result.text.endsWith("b…")).toBe(true);
    });
});

describe("prepareExcerpt", () => {
    it("normalizes then caps in one step", () => {
        expect(prepareExcerpt("  hello   world  ")).toEqual({
            text: "hello world",
            truncated: false,
        });
    });

    it("reports truncation for an over-long selection", () => {
        const result = prepareExcerpt("word ".repeat(2000));
        expect(result.truncated).toBe(true);
        expect(result.text.length).toBeLessThanOrEqual(
            MAX_QUOTED_EXCERPT_CHARS + 1,
        );
    });
});

describe("buildQuotedMessageContent", () => {
    it("returns the body unchanged when there are no excerpts", () => {
        expect(buildQuotedMessageContent([], "what does this mean?")).toBe(
            "what does this mean?",
        );
    });

    it("ignores blank excerpts", () => {
        expect(buildQuotedMessageContent(["", "   "], "hi")).toBe("hi");
    });

    it("prefixes a single excerpt as a markdown blockquote", () => {
        expect(buildQuotedMessageContent(["the indemnity clause"], "why?")).toBe(
            [
                QUOTED_EXCERPT_PREFACE,
                "",
                "> the indemnity clause",
                "",
                "why?",
            ].join("\n"),
        );
    });

    it("separates multiple excerpts with a blank line", () => {
        expect(buildQuotedMessageContent(["first", "second"], "compare")).toBe(
            [
                QUOTED_EXCERPT_PREFACE,
                "",
                "> first",
                "",
                "> second",
                "",
                "compare",
            ].join("\n"),
        );
    });

    it("prefixes every line of a multi-line excerpt, blank lines included", () => {
        const built = buildQuotedMessageContent(["a\n\nb"], "explain");
        expect(built).toBe(
            [
                QUOTED_EXCERPT_PREFACE,
                "",
                "> a",
                ">",
                "> b",
                "",
                "explain",
            ].join("\n"),
        );
    });

    it("trims the body", () => {
        expect(buildQuotedMessageContent(["q"], "  ask  ")).toBe(
            [QUOTED_EXCERPT_PREFACE, "", "> q", "", "ask"].join("\n"),
        );
    });

    it("omits the body section entirely when the body is blank", () => {
        expect(buildQuotedMessageContent(["q"], "   ")).toBe(
            [QUOTED_EXCERPT_PREFACE, "", "> q"].join("\n"),
        );
    });
});

describe("parseQuotedMessageContent", () => {
    it("passes an ordinary message through as the body", () => {
        expect(parseQuotedMessageContent("just a question")).toEqual({
            excerpts: [],
            body: "just a question",
        });
    });

    it("passes a message that merely contains a blockquote through", () => {
        const content = "> not ours\n\nhello";
        expect(parseQuotedMessageContent(content)).toEqual({
            excerpts: [],
            body: content,
        });
    });

    it("treats a bare preface line with no blockquote as ordinary prose", () => {
        const content = `${QUOTED_EXCERPT_PREFACE}\n\nnothing quoted`;
        expect(parseQuotedMessageContent(content)).toEqual({
            excerpts: [],
            body: content,
        });
    });

    it("recovers one excerpt and the body", () => {
        expect(
            parseQuotedMessageContent(
                [QUOTED_EXCERPT_PREFACE, "", "> clause 4.2", "", "why?"].join(
                    "\n",
                ),
            ),
        ).toEqual({ excerpts: ["clause 4.2"], body: "why?" });
    });

    it("recovers multiple excerpts", () => {
        expect(
            parseQuotedMessageContent(
                [
                    QUOTED_EXCERPT_PREFACE,
                    "",
                    "> first",
                    "",
                    "> second",
                    "",
                    "compare them",
                ].join("\n"),
            ),
        ).toEqual({ excerpts: ["first", "second"], body: "compare them" });
    });

    it("keeps a multi-line body intact", () => {
        expect(
            parseQuotedMessageContent(
                [
                    QUOTED_EXCERPT_PREFACE,
                    "",
                    "> quoted",
                    "",
                    "line one",
                    "line two",
                ].join("\n"),
            ),
        ).toEqual({ excerpts: ["quoted"], body: "line one\nline two" });
    });

    it("handles a message with excerpts and no body", () => {
        expect(
            parseQuotedMessageContent(
                [QUOTED_EXCERPT_PREFACE, "", "> only a quote"].join("\n"),
            ),
        ).toEqual({ excerpts: ["only a quote"], body: "" });
    });

    it("decodes a quote marker with no following space", () => {
        expect(
            parseQuotedMessageContent(
                [QUOTED_EXCERPT_PREFACE, "", ">tight", "", "ok"].join("\n"),
            ),
        ).toEqual({ excerpts: ["tight"], body: "ok" });
    });

    it("tolerates extra blank lines after the preface", () => {
        expect(
            parseQuotedMessageContent(
                [QUOTED_EXCERPT_PREFACE, "", "", "> spaced", "", "ok"].join(
                    "\n",
                ),
            ),
        ).toEqual({ excerpts: ["spaced"], body: "ok" });
    });

    it("tolerates a preface line with trailing whitespace", () => {
        expect(
            parseQuotedMessageContent(
                [`${QUOTED_EXCERPT_PREFACE}  `, "", "> q", "", "ok"].join("\n"),
            ),
        ).toEqual({ excerpts: ["q"], body: "ok" });
    });

    it("tolerates extra blank lines between excerpts", () => {
        expect(
            parseQuotedMessageContent(
                [
                    QUOTED_EXCERPT_PREFACE,
                    "",
                    "> first",
                    "",
                    "",
                    "> second",
                    "",
                    "",
                    "ask",
                ].join("\n"),
            ),
        ).toEqual({ excerpts: ["first", "second"], body: "ask" });
    });

    it("handles a body that starts immediately after the quote", () => {
        expect(
            parseQuotedMessageContent(
                [QUOTED_EXCERPT_PREFACE, "", "> q", "straight on"].join("\n"),
            ),
        ).toEqual({ excerpts: ["q"], body: "straight on" });
    });

    it("returns an empty body for an empty message", () => {
        expect(parseQuotedMessageContent("")).toEqual({
            excerpts: [],
            body: "",
        });
    });
});

describe("round trip", () => {
    it.each([
        [["one"], "body"],
        [["one", "two", "three"], "compare these"],
        [["line a\nline b"], "multi-line excerpt"],
        [["with\n\nblank line"], "blank inside"],
        [[">already quoted"], "nested marker"],
        [["one"], "body\nwith\nlines"],
    ])("survives build -> parse for %j / %j", (excerpts, body) => {
        const built = buildQuotedMessageContent(excerpts, body);
        expect(parseQuotedMessageContent(built)).toEqual({ excerpts, body });
    });
});

describe("hasQuotedExcerpts", () => {
    it("is false for an ordinary message", () => {
        expect(hasQuotedExcerpts("plain")).toBe(false);
    });

    it("is true for a message carrying excerpts", () => {
        expect(
            hasQuotedExcerpts(buildQuotedMessageContent(["q"], "ask")),
        ).toBe(true);
    });
});
