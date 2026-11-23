import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
    EventSourceUI,
} from "./DocumentEventBlocksUI";

describe("DocumentEventBlocksUI", () => {
    it("renders a clickable completed document read", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();

        render(
            <DocReadBlockUI filename="agreement.docx" onClick={onClick} />,
        );

        await user.click(screen.getByRole("button", { name: "agreement.docx" }));
        expect(onClick).toHaveBeenCalledOnce();
        expect(screen.getByText("Read")).toBeVisible();
    });

    it("renders document-find progress and match counts", () => {
        const { rerender } = render(
            <DocFindBlockUI
                filename="agreement.docx"
                query="termination"
                totalMatches={0}
                isStreaming
            />,
        );

        expect(screen.getByText("Finding")).toBeVisible();
        expect(screen.getByText("agreement.docx").parentElement).toHaveTextContent(
            "agreement.docx...",
        );

        rerender(
            <DocFindBlockUI
                filename="agreement.docx"
                query="termination"
                totalMatches={2}
            />,
        );
        expect(screen.getByText("agreement.docx").parentElement).toHaveTextContent(
            "2 matches",
        );
    });

    it("renders normalized document-edit labels and details", () => {
        render(
            <DocEditBlockUI
                label="Couldn’t apply tracked change"
                filename="agreement.docx"
                fileIcon={<span data-testid="edit-file-icon" />}
                detail="Selection moved"
                dotColor="red"
                labelTone="error"
            />,
        );

        expect(screen.getByText("Couldn’t apply tracked change")).toHaveClass(
            "text-red-500",
        );
        expect(screen.getByTestId("edit-file-icon")).toBeVisible();
        expect(screen.getByText("agreement.docx")).toBeVisible();
        expect(screen.getByText("Selection moved")).toBeVisible();
    });

    it("names a source with its icon, and opens it only once the step is done", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(
            <EventSourceUI
                name="Companies Act 2006"
                icon={<span data-testid="source-icon" />}
                onClick={onClick}
                isStreaming
            />,
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.getByText("Companies Act 2006...")).toBeVisible();

        rerender(
            <EventSourceUI
                name="Companies Act 2006"
                icon={<span data-testid="source-icon" />}
                onClick={onClick}
            />,
        );
        await user.click(screen.getByRole("button", { name: "Companies Act 2006" }));
        expect(onClick).toHaveBeenCalledOnce();
        expect(screen.getByTestId("source-icon")).toBeVisible();
    });
});
