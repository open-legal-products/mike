import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotedMessageContent } from "./QuotedMessageContent";
import {
    buildQuotedMessageContent,
    QUOTED_EXCERPT_PREFACE,
} from "@/app/lib/quotedExcerpts";

describe("QuotedMessageContent", () => {
    it("renders an ordinary message as plain preformatted text", () => {
        const { container } = render(
            <QuotedMessageContent content={"line one\nline two"} />,
        );
        const paragraph = container.querySelector("p");
        expect(paragraph).toHaveTextContent("line one line two");
        expect(paragraph).toHaveClass("whitespace-pre-wrap");
        expect(container.querySelector("blockquote")).toBeNull();
    });

    it("applies the caller's typography class to the body", () => {
        const { container } = render(
            <QuotedMessageContent content="hello" className="text-sm" />,
        );
        expect(container.querySelector("p")).toHaveClass("text-sm");
    });

    it("renders a single attached excerpt as a quote block", () => {
        render(
            <QuotedMessageContent
                content={buildQuotedMessageContent(
                    ["the indemnity clause"],
                    "why does this apply?",
                )}
            />,
        );
        expect(screen.getByText("Quoted from response")).toBeInTheDocument();
        expect(
            screen.getByText("the indemnity clause").tagName,
        ).toBe("BLOCKQUOTE");
        expect(screen.getByText("why does this apply?")).toBeInTheDocument();
        // The wire-format scaffolding must not leak into the UI.
        expect(screen.queryByText(QUOTED_EXCERPT_PREFACE)).toBeNull();
    });

    it("renders several excerpts with a counted label", () => {
        const { container } = render(
            <QuotedMessageContent
                content={buildQuotedMessageContent(
                    ["first point", "second point"],
                    "compare these",
                )}
            />,
        );
        expect(
            screen.getByText("2 quotes from response"),
        ).toBeInTheDocument();
        expect(container.querySelectorAll("blockquote")).toHaveLength(2);
        expect(screen.getByText("compare these")).toBeInTheDocument();
    });

    it("omits the body paragraph when the message is quotes only", () => {
        const { container } = render(
            <QuotedMessageContent
                content={buildQuotedMessageContent(["just this"], "")}
            />,
        );
        expect(container.querySelectorAll("blockquote")).toHaveLength(1);
        expect(container.querySelectorAll("p")).toHaveLength(1); // the label
    });

    it("leaves a user-authored blockquote alone", () => {
        const content = "> I typed this myself\n\nand this";
        const { container } = render(
            <QuotedMessageContent content={content} />,
        );
        expect(container.querySelector("blockquote")).toBeNull();
        expect(container.querySelector("p")).toHaveTextContent(
            "> I typed this myself and this",
        );
    });
});
