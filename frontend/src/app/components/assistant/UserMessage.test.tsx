import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMessage } from "./UserMessage";
import {
    buildQuotedMessageContent,
    QUOTED_EXCERPT_PREFACE,
} from "@/app/lib/quotedExcerpts";

describe("UserMessage", () => {
    it("opens a document-backed file pill", async () => {
        const onFileClick = vi.fn();
        const user = userEvent.setup();
        const file = {
            filename: "agreement.docx",
            document_id: "document-1",
        };

        render(
            <UserMessage
                content="Review this"
                files={[file]}
                onFileClick={onFileClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open agreement.docx" }),
        );
        expect(onFileClick).toHaveBeenCalledWith(file);
    });

    it("renders an ordinary message as plain text", () => {
        const { container } = render(<UserMessage content="Review this" />);
        expect(container.querySelector("p")).toHaveTextContent("Review this");
        expect(container.querySelector("blockquote")).toBeNull();
    });

    it("renders attached excerpts as quote blocks, not raw markdown", () => {
        const { container } = render(
            <UserMessage
                content={buildQuotedMessageContent(
                    ["the indemnity clause"],
                    "why does this apply?",
                )}
            />,
        );

        expect(
            screen.getByText("the indemnity clause").tagName,
        ).toBe("BLOCKQUOTE");
        expect(screen.getByText("why does this apply?")).toBeInTheDocument();
        // The bubble is plain text, so the wire-format scaffolding would
        // otherwise be visible verbatim.
        expect(container.textContent).not.toContain(QUOTED_EXCERPT_PREFACE);
        expect(container.textContent).not.toContain("> the indemnity");
    });
});
