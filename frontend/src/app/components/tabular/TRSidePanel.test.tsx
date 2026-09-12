import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
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
            withIntl(
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
            ),
        );

        expect(screen.getByText("PDF doc-1")).toBeInTheDocument();
        expect(screen.getByText("Versão")).toBeInTheDocument();
        expect(screen.getByText("V3")).toBeInTheDocument();
        expect(screen.queryByText("Coluna")).not.toBeInTheDocument();
        expect(screen.queryByText("Resultados")).not.toBeInTheDocument();
        expect(screen.queryByTitle("Regenerar")).not.toBeInTheDocument();
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

        const { container } = render(
            withIntl(
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
            ),
        );

        expect(
            container.querySelector('img[src*="folder-closed"]'),
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

        fireEvent.click(screen.getByTitle('Página 4: "Exact language"'));

        expect(screen.getByText("PDF doc-2")).toBeInTheDocument();
    });
});
