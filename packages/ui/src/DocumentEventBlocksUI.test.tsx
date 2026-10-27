import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
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
});
