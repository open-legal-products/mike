import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { TRSidePanel } from "./TRSidePanel";

vi.mock("../shared/views/PdfView", () => ({
    PdfView: ({ doc }: { doc: { document_id: string } }) => (
        <div>PDF {doc.document_id}</div>
    ),
}));
vi.mock("../shared/views/DocxView", () => ({
    DocxView: () => <div>DOCX</div>,
}));
vi.mock("../shared/views/SpreadsheetView", () => ({
    SpreadsheetView: () => <div>Spreadsheet</div>,
}));

describe("TRSidePanel", () => {
    it("shows only document metadata for a document-name click", () => {
        const document = {
            id: "doc-1",
            filename: "Agreement.pdf",
            file_type: "pdf",
            active_version_number: 3,
        } as Document;
        const row = {
            id: "row-1",
            label: document.filename,
            row_type: "document",
            document_id: document.id,
            source_document_ids: [document.id],
        } as TabularReviewRow;
        const column = {
            index: 0,
            name: "Clause",
            prompt: "Extract the clause",
        } as ColumnConfig;
        const cell = {
            id: "cell-1",
            row_id: row.id,
            column_index: column.index,
            status: "done",
            content: {
                summary: "A result that should stay hidden",
                flag: "green",
                reasoning: "Hidden reasoning",
            },
        } as TabularCell;

        render(
            <TRSidePanel
                cell={cell}
                row={row}
                rows={[row]}
                document={document}
                documents={[document]}
                column={column}
                columns={[column]}
                displayDocument
                documentOnly
                onClose={vi.fn()}
                onNavigate={vi.fn()}
                onRegenerate={vi.fn()}
            />,
        );

        expect(screen.getByText("PDF doc-1")).toBeInTheDocument();
        expect(screen.getByText("Version")).toBeInTheDocument();
        expect(screen.getByText("V3")).toBeInTheDocument();
        expect(screen.queryByText("Column")).not.toBeInTheDocument();
        expect(screen.queryByText("Results")).not.toBeInTheDocument();
        expect(screen.queryByTitle("Regenerate")).not.toBeInTheDocument();
    });

    it("opens the source document encoded in a grouped-row citation", () => {
        const documents = [
            {
                id: "doc-1",
                filename: "First.pdf",
                file_type: "pdf",
            },
            {
                id: "doc-2",
                filename: "Second.pdf",
                file_type: "pdf",
            },
        ] as Document[];
        const row = {
            id: "row-1",
            label: "Closing",
            row_type: "folder",
            document_id: null,
            source_document_ids: ["doc-1", "doc-2"],
        } as TabularReviewRow;
        const column = {
            index: 0,
            name: "Clause",
            prompt: "Extract the clause",
        } as ColumnConfig;
        const cell = {
            id: "cell-1",
            row_id: row.id,
            column_index: column.index,
            status: "done",
            content: {
                summary:
                    "Answer [[document:doc-2||page:4||quote:Exact language]]",
                flag: "grey",
                reasoning: "",
            },
        } as TabularCell;

        const view = render(
            <TRSidePanel
                cell={cell}
                row={row}
                rows={[row]}
                documents={documents}
                column={column}
                columns={[column]}
                onClose={vi.fn()}
                onNavigate={vi.fn()}
            />,
        );

        expect(
            view.container.querySelector('img[src*="folder-closed"]'),
        ).toBeInTheDocument();

        const folderButton = screen.getByRole("button", { name: "Closing" });
        expect(folderButton).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("button", { name: "First.pdf" }),
        ).not.toBeInTheDocument();

        fireEvent.click(folderButton);

        expect(folderButton).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(screen.getByRole("button", { name: "First.pdf" }));

        expect(screen.getByText("PDF doc-1")).toBeInTheDocument();

        fireEvent.click(screen.getByTitle('Page 4: "Exact language"'));

        expect(screen.getByText("PDF doc-2")).toBeInTheDocument();

        // A new citation and source removal can arrive together. Reconciliation
        // must not clear the new citation while retiring the old selection.
        view.rerender(<TRSidePanel cell={cell} row={row} rows={[row]}
            documents={[documents[0]]} column={column} columns={[column]}
            displayDocument citationDocumentId="doc-1" citationQuote="New source quote"
            onClose={vi.fn()} onNavigate={vi.fn()} />);
        expect(screen.getByText("PDF doc-1")).toBeInTheDocument();
        expect(screen.getByText(/New source quote/)).toBeInTheDocument();
    });
});


it("preserves the chosen grouped source and collapsed pane through 300 row refreshes", () => {
    const documents = [
        { id: "doc-1", filename: "First.pdf", file_type: "pdf" },
        { id: "doc-2", filename: "Second.pdf", file_type: "pdf" },
    ] as Document[];
    const row = { id: "row-1", label: "Closing", row_type: "folder",
        document_id: null, source_document_ids: ["doc-1", "doc-2"] } as TabularReviewRow;
    const column = { index: 0, name: "Clause", prompt: "Extract" } as ColumnConfig;
    const cell = { id: "cell-1", row_id: row.id, column_index: 0, status: "done",
        content: { summary: "Answer", flag: "grey", reasoning: "" } } as TabularCell;
    const props = { cell, row, rows: [row], documents, document: documents[0],
        column, columns: [column], displayDocument: true, onClose: vi.fn(), onNavigate: vi.fn() };
    const view = render(<TRSidePanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Closing" }));
    fireEvent.click(screen.getByRole("button", { name: "Second.pdf" }));
    expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
    for (let i = 0; i < 300; i++) {
        view.rerender(<TRSidePanel {...props} row={{ ...row }}
            documents={documents.map((document) => ({ ...document }))}
            document={{ ...documents[0] }} />);
    }
    expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse document pane" }));
    view.rerender(<TRSidePanel {...props} row={{ ...row }} />);
    expect(screen.queryByText("PDF doc-1")).not.toBeInTheDocument();
    expect(screen.queryByText("PDF doc-2")).not.toBeInTheDocument();
    // Actual navigation still resets to the next cell's requested source.
    view.rerender(<TRSidePanel {...props} cell={{ ...cell, id: "cell-2" }} />);
    expect(screen.getByText("PDF doc-1")).toBeInTheDocument();
});

it.each(["membership", "document"] as const)(
    "retires a grouped source removed from the %s list without reopening it on refresh",
    (removedFrom) => {
        const documents = [
            { id: "doc-1", filename: "First.pdf", file_type: "pdf" },
            { id: "doc-2", filename: "Second.pdf", file_type: "pdf" },
        ] as Document[];
        const row = { id: "row-1", label: "Closing", row_type: "folder",
            document_id: null, source_document_ids: ["doc-1", "doc-2"] } as TabularReviewRow;
        const column = { index: 0, name: "Clause", prompt: "Extract" } as ColumnConfig;
        const cell = { id: "cell-1", row_id: row.id, column_index: 0, status: "done",
            content: { summary: "Answer", flag: "grey", reasoning: "" } } as TabularCell;
        const props = { cell, row, rows: [row], documents, column, columns: [column],
            onClose: vi.fn(), onNavigate: vi.fn() };
        const view = render(<TRSidePanel {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Closing" }));
        fireEvent.click(screen.getByRole("button", { name: "Second.pdf" }));
        expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
        view.rerender(<TRSidePanel {...props}
            row={removedFrom === "membership" ? { ...row, source_document_ids: ["doc-1"] } : row}
            documents={removedFrom === "document" ? [documents[0]] : documents} />);
        expect(screen.queryByText("PDF doc-2")).not.toBeInTheDocument();
        view.rerender(<TRSidePanel {...props} />);
        expect(screen.queryByText("PDF doc-2")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Collapse document pane" })).not.toBeInTheDocument();
        // A fresh user choice can still open the restored source.
        fireEvent.click(screen.getByRole("button", { name: "Second.pdf" }));
        expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
    },
);

it.each([true, false])("falls back from a removed source while preserving pane openness=%s", (open) => {
    const documents = [
        { id: "doc-1", filename: "First.pdf", file_type: "pdf" },
        { id: "doc-2", filename: "Second.pdf", file_type: "pdf" },
    ] as Document[];
    const row = { id: "row-1", label: "Closing", row_type: "folder",
        document_id: null, source_document_ids: ["doc-1", "doc-2"] } as TabularReviewRow;
    const column = { index: 0, name: "Clause", prompt: "Extract" } as ColumnConfig;
    const cell = { id: "cell-1", row_id: row.id, column_index: 0, status: "done",
        content: { summary: "Answer", flag: "grey", reasoning: "" } } as TabularCell;
    const props = { cell, row, rows: [row], documents, document: documents[0],
        column, columns: [column], displayDocument: true, onClose: vi.fn(), onNavigate: vi.fn() };
    const view = render(<TRSidePanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Closing" }));
    fireEvent.click(screen.getByRole("button", { name: "Second.pdf" }));
    if (!open) fireEvent.click(screen.getByRole("button", { name: "Collapse document pane" }));
    view.rerender(<TRSidePanel {...props} documents={[documents[0]]} />);
    view.rerender(<TRSidePanel {...props} />);
    expect(screen.queryByText("PDF doc-2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: open ? "Collapse document pane" : "Expand document pane" }))
        .toHaveAttribute("aria-pressed", String(open));
    if (!open) fireEvent.click(screen.getByRole("button", { name: "Expand document pane" }));
    expect(screen.getByText("PDF doc-1")).toBeInTheDocument();
});
