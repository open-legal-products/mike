import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { TRTable } from "./TRTable";
import type { Document, TabularReviewRow } from "../shared/types";

const row = {
    id: "row-1",
    label: "Contracts",
    row_type: "folder",
    document_id: null,
    source_document_ids: ["doc-1", "doc-2"],
} as TabularReviewRow;
const documents = [
    {
        id: "doc-1",
        filename: "Agreement.pdf",
        file_type: "pdf",
    },
    {
        id: "doc-2",
        filename: "Schedule.docx",
        file_type: "docx",
    },
] as Document[];

function renderTable(
    documentGrouping: "document" | "folder" = "folder",
    tableRows: TabularReviewRow[] = [row],
    onDocumentOpen = vi.fn(),
) {
    const renderResult = render(
        withIntl(
            <TRTable
                loading={false}
                documentGrouping={documentGrouping}
                columns={[]}
                rows={tableRows}
                documents={documents}
                cells={[]}
                savingColumn={false}
                savingColumnsConfig={false}
                selectedRowIds={[]}
                onSelectionChange={vi.fn()}
                onDocumentOpen={onDocumentOpen}
                onExpand={vi.fn()}
                onCitationClick={vi.fn()}
                onUpdateColumn={vi.fn()}
                onDeleteColumn={vi.fn()}
                onAddColumn={vi.fn()}
                onAddDocuments={vi.fn()}
            />,
        ),
    );
    return { ...renderResult, onDocumentOpen };
}

describe("TRTable", () => {
    // The grid here is div-based (no table/columnheader/rowheader roles), so
    // this asserts on rendered content rather than ARIA table semantics.
    it("renders one table row for a grouped folder", () => {
        const { container } = renderTable();
        expect(screen.getByText("Pasta / Documento")).toBeInTheDocument();
        expect(
            screen.getByText("Pasta / Documento").parentElement,
        ).toHaveClass(
            "text-gray-700",
        );
        expect(screen.getByText("Contracts")).toBeInTheDocument();
        expect(container.querySelector(".table-surface")).toHaveClass(
            "tabular-review-table-surface",
        );
        expect(
            screen.getByText("Pasta / Documento").parentElement,
        ).toHaveClass("table-sticky-cell");
        expect(
            screen.getByText("Contracts").closest(".table-sticky-cell"),
        ).not.toBeNull();
        // One select-all checkbox in the header plus one per logical review row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("uses Document as the header for document grouping", () => {
        renderTable("document");
        expect(screen.getByText("Documento")).toBeInTheDocument();
        expect(
            screen.queryByText("Pasta / Documento"),
        ).not.toBeInTheDocument();
    });

    it("expands a folder row to list its source documents", () => {
        const { onDocumentOpen } = renderTable();
        fireEvent.click(screen.getByText("Contracts"));
        expect(screen.getByText("Agreement.pdf")).toBeInTheDocument();
        expect(screen.getByText("Schedule.docx")).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Open Agreement.pdf" }),
        );
        expect(onDocumentOpen).toHaveBeenCalledWith(row, documents[0]);
    });

    it("opens a standalone document row from its document name", () => {
        const documentRow = {
            ...row,
            label: "Agreement.pdf",
            row_type: "document",
            document_id: "doc-1",
            source_document_ids: ["doc-1"],
        } as TabularReviewRow;
        const { onDocumentOpen } = renderTable(
            "document",
            [documentRow],
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Open Agreement.pdf" }),
        );

        expect(onDocumentOpen).toHaveBeenCalledWith(
            documentRow,
            documents[0],
        );
    });
});
