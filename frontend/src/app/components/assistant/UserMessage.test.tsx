import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMessage } from "./UserMessage";

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

    it("reveals the workflow behind the pill", async () => {
        const user = userEvent.setup();
        const onWorkflowClick = vi.fn();
        render(
            <UserMessage
                content="Run the diligence review"
                workflow={{ id: "wf-1", title: "Diligence review" }}
                onWorkflowClick={onWorkflowClick}
            />,
        );

        await user.click(
            screen.getByRole("button", {
                name: "Open workflow Diligence review",
            }),
        );

        expect(onWorkflowClick).toHaveBeenCalledWith({
            id: "wf-1",
            title: "Diligence review",
        });
    });

    it("shows excerpts as pills that open the passage and its note", async () => {
        const user = userEvent.setup();
        render(
            <UserMessage
                content={
                    "> Notice is 30 days.\nNote: Is that standard?\n\n> Clause 4\n\nExplain."
                }
            />,
        );

        expect(screen.getByText("Explain.")).toBeInTheDocument();
        expect(screen.getByText("Annotated Excerpt")).toBeInTheDocument();
        expect(screen.getByText("Excerpt")).toBeInTheDocument();
        // The passage and note stay out of the bubble until a pill is opened.
        expect(screen.queryByText("Notice is 30 days.")).toBeNull();
        expect(screen.queryByText(/^>/)).toBeNull();

        await user.click(
            screen.getByRole("button", {
                name: "View excerpt: Notice is 30 days.",
            }),
        );
        const dialog = await screen.findByRole("dialog", {
            name: "Annotated Excerpt",
        });
        expect(within(dialog).getByText("Notice is 30 days.")).toBeVisible();
        expect(within(dialog).getByText("Is that standard?")).toBeVisible();
    });

    it("shows only the pill for an annotated excerpt sent on its own", () => {
        const { container } = render(
            <UserMessage content={"> Clause 4\nNote: Why?"} />,
        );

        expect(screen.getByText("Annotated Excerpt")).toBeInTheDocument();
        expect(container.querySelector("p")).toBeNull();
    });
});
