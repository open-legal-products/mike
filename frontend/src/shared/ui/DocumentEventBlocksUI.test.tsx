import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
    DocSearchBlockUI,
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


describe("scoped document search", () => {
    const event = { type: "doc_search" as const, search_id: "search", scope: "project", query: "change of control", offset: 0 };
    it("shows progress then a page of results without implying the total", () => {
        const { rerender } = render(<DocSearchBlockUI event={event} isStreaming />);
        expect(screen.getByText(/project documents for/)).toHaveTextContent("Searching project documents for “change of control”...");
        expect(screen.queryByText(/matching document/)).not.toBeInTheDocument();
        rerender(<DocSearchBlockUI event={{ ...event, offset: 10, match_count: 1, next_offset: 11 }} />);
        expect(screen.getByText(/1 matching document/)).toHaveTextContent("1 matching document (results 11–11); more results available.");
    });
    it("does not present incomplete coverage as a definitive absence", () => {
        render(<DocSearchBlockUI event={{ ...event, match_count: 0, coverage: { total_versions: 4, indexed_versions: 2, pending_versions: 1, failed_versions: 1, versions_needing_ocr: 1 } }} />);
        expect(screen.getByText(/Search coverage is incomplete/)).toHaveTextContent("2 of 4 document versions searchable. 1 awaiting extraction. 1 extraction failed. 1 may contain unsearchable scanned pages.");
    });
    it("distinguishes failure from a successful search with zero results", () => {
        render(<DocSearchBlockUI event={{ ...event, error: "Document search could not be completed. Try again." }} />);
        expect(screen.getByText(/Search failed in/)).toBeVisible();
        expect(screen.queryByText(/No matching documents/)).not.toBeInTheDocument();
    });
});
