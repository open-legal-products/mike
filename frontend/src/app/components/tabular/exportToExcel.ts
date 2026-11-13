"use client";

import ExcelJS from "exceljs";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { preprocessCitations } from "./citation-utils";

function formatCellForExport(cell: TabularCell | undefined): string {
    if (!cell) return "";
    if (cell.status === "pending" || cell.status === "generating") return "";
    if (cell.status === "error") return "Error";
    const summary = cell.content?.summary;
    if (!summary) return "";
    const { processed } = preprocessCitations(summary);
    return processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Tabular Review"
    );
}

interface ExportParams {
    reviewTitle: string;
    columns: ColumnConfig[];
    rows: TabularReviewRow[];
    cells: TabularCell[];
    documents: Pick<Document, "id" | "filename">[];
}

export class ExcelExportLimitError extends Error {}

/** Excel limits include the header row. Count UTF-16 units conservatively. */
export function assertExcelRowFits(values: (string | number)[], rowNumber: number) {
    if (rowNumber > 1048576 || values.length > 16384) {
        throw new ExcelExportLimitError("Excel export exceeds 1,048,576 rows or 16,384 columns. Nothing was downloaded; export a smaller review.");
    }
    if (values.some((value) => typeof value === "string" && value.length > 32767)) {
        throw new ExcelExportLimitError("Excel export contains text longer than 32,767 characters in one cell. Nothing was downloaded; shorten the content before exporting.");
    }
}

export function buildTabularReviewWorkbook(params: ExportParams) {
    const { columns, rows, cells, documents } = params;
    assertExcelRowFits(["Folder / document", ...columns.map((col) => col.name)], rows.length + 1);

    const sortedCols = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map<string, TabularCell>();
    for (const cell of cells) {
        cellMap.set(`${cell.row_id}:${cell.column_index}`, cell);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Review");

    ws.columns = [
        { header: "Folder / document", width: 40 },
        ...sortedCols.map((c) => ({ header: c.name, width: 40 })),
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle" };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };

    for (const reviewRow of rows) {
        const row: string[] = [reviewRow.label];
        for (const col of sortedCols) {
            row.push(
                formatCellForExport(
                    cellMap.get(`${reviewRow.id}:${col.index}`),
                ),
            );
        }
        assertExcelRowFits(row, ws.rowCount + 1);
        const excelRow = ws.addRow(row);
        excelRow.alignment = { vertical: "top", wrapText: true };
    }

    const evidence = wb.addWorksheet("Evidence");
    evidence.columns = [
        "Answer address", "Review ID", "Row ID", "Row label", "Column index", "Column name",
        "Cell ID", "Record", "Stored status", "Content", "Flag", "Reasoning", "Raw summary",
        "Row source IDs (JSON)", "Cell document ID", "Citation number", "Citation document ID",
        "Source document ID", "Source filename", "Source resolution", "Page", "Sheet", "Location", "Quotation",
    ].map((header) => ({ header, width: 24 }));
    evidence.getRow(1).font = { bold: true };
    evidence.views = [{ state: "frozen", ySplit: 1 }];
    const filenames = new Map(documents.map((doc) => [doc.id, doc.filename]));
    rows.forEach((reviewRow, rowIndex) => {
        sortedCols.forEach((col, colIndex) => {
            const cell = cellMap.get(`${reviewRow.id}:${col.index}`);
            const citations = preprocessCitations(cell?.content?.summary ?? "").citations;
            const address = `Review!${ws.getRow(rowIndex + 2).getCell(colIndex + 2).address}`;
            // One record even without a citation: unfinished/missing answers must not disappear.
            for (const [index, citation] of (citations.length ? citations : [undefined]).entries()) {
                const sourceId = citation?.documentId ?? (citation && reviewRow.source_document_ids.length === 1
                    ? reviewRow.source_document_ids[0] : undefined);
                const filename = sourceId ? filenames.get(sourceId) : undefined;
                const resolution = !citation ? "No recognized summary citation"
                    : !sourceId ? "Unresolved: citation has no document ID; row is not single-source"
                    : filename === undefined ? "Unresolved: source metadata not supplied"
                    : citation.documentId ? "Explicit citation document ID"
                    : "Inferred from single-source row";
                const values = [
                    address, reviewRow.review_id, reviewRow.id, reviewRow.label, col.index, col.name,
                    cell?.id ?? "", cell ? "Present" : "Absent", cell?.status ?? "",
                    cell?.content ? "Present" : cell ? "Null" : "Absent",
                    cell?.content?.flag ?? "", cell?.content?.reasoning ?? "", cell?.content?.summary ?? "",
                    JSON.stringify(reviewRow.source_document_ids), cell?.document_id ?? "",
                    citation ? index + 1 : "", citation?.documentId ?? "", sourceId ?? "", filename ?? "",
                    resolution, citation?.page ?? "", citation?.sheet ?? "", citation?.cell ?? "", citation?.quote ?? "",
                ];
                assertExcelRowFits(values, evidence.rowCount + 1);
                const record = evidence.addRow(values);
                record.alignment = { vertical: "top", wrapText: true };
            }
        });
    });
    evidence.autoFilter = { from: "A1", to: `X${evidence.rowCount}` };
    return wb;
}

export async function exportTabularReviewToExcel(params: ExportParams) {
    const wb = buildTabularReviewWorkbook(params);
    const { reviewTitle } = params;
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(reviewTitle)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
