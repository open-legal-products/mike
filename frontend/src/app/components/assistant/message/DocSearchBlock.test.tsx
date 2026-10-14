import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocSearchBlock } from "./DocSearchBlock";

const event = { type: "doc_search" as const, search_id: "search", scope: "project", query: "change of control", offset: 0 };

describe("document search disclosure", () => {
    it.each([0, 1, 3])("reveals only the match count (%s) when expanded", count => {
        render(<DocSearchBlock event={{ ...event, offset: 10, match_count: count, next_offset: 13,
            coverage: { total_versions: 4, indexed_versions: 2, pending_versions: 1, failed_versions: 1, versions_needing_ocr: 1 } }} />);
        const button = screen.getByRole("button", { name: "Searched project documents for “change of control”" });
        const text = `${count} ${count === 1 ? "match" : "matches"}`;
        expect(button).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText(text)).not.toBeInTheDocument();
        fireEvent.click(button);
        expect(button).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText(text)).toBeVisible();
        expect(screen.queryByText(/coverage|extraction|more results|results 11/)).not.toBeInTheDocument();
        fireEvent.click(button);
        expect(screen.queryByText(text)).not.toBeInTheDocument();
    });

    it("does not show a zero count while streaming or after failure", () => {
        const { rerender } = render(<DocSearchBlock event={event} isStreaming />);
        fireEvent.click(screen.getByRole("button", { name: "Searching project documents for “change of control”..." }));
        expect(screen.queryByText("0 matches")).not.toBeInTheDocument();
        rerender(<DocSearchBlock event={{ ...event, error: "Document search could not be completed. Try again." }} />);
        expect(screen.getByRole("button", { name: /Search failed in/ })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Document search could not be completed. Try again.")).toBeVisible();
        expect(screen.queryByText("0 matches")).not.toBeInTheDocument();
    });
});
