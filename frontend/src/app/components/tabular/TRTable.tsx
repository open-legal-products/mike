"use client";

import {
    forwardRef,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import { Loader2, Plus, Upload } from "lucide-react";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { TabularCell as TabularCellComponent } from "./TabularCell";
import { TREditColumnMenu } from "./TREditColumnMenu";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
    TableScrollArea,
} from "../shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { TRFirstColumnCell } from "./TRFirstColumnCell";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_GROUP_HOVER_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";

const SKELETON_COLS = 4;
const SKELETON_ROWS = 5;

const COL_W = "w-[300px] shrink-0";
const DOC_COL_W = "w-[332px] shrink-0";
const TR_STICKY_CELL_CLASS = "table-sticky-cell";
// The review grid keeps the wider page gutter. Its first column is a fixed
// 332px cell rather than a checkbox aligned to the page header, so the
// narrower gutter the other tables use would buy it nothing.
const TR_GUTTER_CLASS = "md:mx-8";

// Pixel widths matching the CSS constants above
const DOC_COL_W_PX = 332;
const DATA_COL_W_PX = 300;
const STICKY_LEFT_PX = DOC_COL_W_PX;

export interface TRTableHandle {
    scrollToCell: (colIdx: number, rowIdx: number) => void;
}

interface Props {
    loading: boolean;
    documentGrouping: "document" | "folder";
    columns: ColumnConfig[];
    rows: TabularReviewRow[];
    documents: Document[];
    cells: TabularCell[];
    savingColumn: boolean;
    savingColumnsConfig: boolean;
    selectedRowIds: string[];
    uploadingFilenames?: string[];
    dragOverFiles?: boolean;
    highlightedCell?: { colIdx: number; rowIdx: number } | null;
    onSelectionChange: (ids: string[]) => void;
    onDocumentOpen: (row: TabularReviewRow, document: Document) => void;
    onExpand: (cell: TabularCell) => void;
    onCitationClick: (
        cell: TabularCell,
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        citationCell?: string,
        documentId?: string,
    ) => void;
    onUpdateColumn: (col: ColumnConfig) => void;
    onDeleteColumn: (colIndex: number) => void;
    onAddColumn: () => void;
    onAddDocuments: () => void;
}

export const TRTable = forwardRef<TRTableHandle, Props>(function TRTable(
    {
        loading,
        documentGrouping,
        columns,
        rows,
        documents,
        cells,
        savingColumn,
        savingColumnsConfig,
        selectedRowIds,
        uploadingFilenames = [],
        dragOverFiles = false,
        highlightedCell,
        onSelectionChange,
        onDocumentOpen,
        onExpand,
        onCitationClick,
        onUpdateColumn,
        onDeleteColumn,
        onAddColumn,
        onAddDocuments,
    },
    ref,
) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const lastScrollLeftRef = useRef(0);
    const [scrollCloseSignal, setScrollCloseSignal] = useState(0);

    function handleRowsScroll() {
        const container = scrollContainerRef.current;
        if (!container) return;

        if (container.scrollLeft !== lastScrollLeftRef.current) {
            lastScrollLeftRef.current = container.scrollLeft;
            setScrollCloseSignal((signal) => signal + 1);
        }
    }

    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const documentsById = new Map(
        documents.map((document) => [document.id, document]),
    );
    const firstColumnLabel =
        documentGrouping === "folder" ? "Folder / Document" : "Document";
    const totalContentWidth =
        DOC_COL_W_PX + sortedColumns.length * DATA_COL_W_PX + 32;
    const skeletonContentWidth =
        DOC_COL_W_PX + SKELETON_COLS * DATA_COL_W_PX + 32;
    useImperativeHandle(ref, () => ({
        scrollToCell(colIdx: number, rowIdx: number) {
            const container = scrollContainerRef.current;
            if (!container) return;

            // Vertical: find actual row via DOM (handles variable row heights)
            const allRows = container.querySelectorAll<HTMLElement>(
                ":scope > div.flex.min-w-full",
            );
            const targetRow = allRows[rowIdx];
            if (targetRow) {
                container.scrollTo({
                    top: Math.max(0, targetRow.offsetTop - 40),
                    behavior: "smooth",
                });
            }

            // Horizontal: fixed column widths — center the target column in view
            const targetScrollLeft =
                STICKY_LEFT_PX +
                colIdx * DATA_COL_W_PX -
                container.clientWidth / 2 +
                DATA_COL_W_PX / 2;
            container.scrollLeft = Math.max(0, targetScrollLeft);
        },
    }));

    function getCell(row: TabularReviewRow, colIdx: number) {
        return cells.find(
            (cell) =>
                cell.row_id === row.id && cell.column_index === colIdx,
        );
    }

    const allSelected =
        rows.length > 0 && rows.every((row) => selectedRowIds.includes(row.id));
    const someSelected =
        !allSelected && rows.some((row) => selectedRowIds.includes(row.id));

    function toggleAll() {
        if (allSelected) {
            onSelectionChange([]);
        } else {
            onSelectionChange(rows.map((row) => row.id));
        }
    }

    function toggleRow(id: string) {
        if (selectedRowIds.includes(id)) {
            onSelectionChange(selectedRowIds.filter((x) => x !== id));
        } else {
            onSelectionChange([...selectedRowIds, id]);
        }
    }

    if (loading) {
        return (
            <TableScrollArea
                preserveGridBorder
                className={TR_GUTTER_CLASS}
                header={
                    <div
                        className="flex h-10 shrink-0"
                        style={{ minWidth: skeletonContentWidth }}
                    >
                        <div
                            className={`sticky left-0 z-[80] ${DOC_COL_W} ${TR_STICKY_CELL_CLASS} flex items-center border-b border-r border-gray-200 py-2 pl-3 pr-2 text-xs font-medium text-gray-700`}
                        >
                            <SkeletonCheckbox />
                            <span>{firstColumnLabel}</span>
                        </div>
                        {Array.from({ length: SKELETON_COLS }).map((_, i) => (
                            <div
                                key={i}
                                className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2`}
                            >
                                <SkeletonLine className="h-4 w-28" />
                            </div>
                        ))}
                        <div className="flex-1 border-b border-gray-200 min-w-8" />
                    </div>
                }
            >
                    {Array.from({ length: SKELETON_ROWS }).map((_, row) => (
                        <div
                            key={row}
                            className="flex h-8"
                            style={{ minWidth: skeletonContentWidth }}
                        >
                            <div className={`${TR_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_COL_W} flex items-center border-b border-r border-gray-200 py-2 pl-3 pr-2`}>
                                <SkeletonCheckbox />
                                <div className="mr-2 h-3.5 w-3.5 shrink-0 rounded bg-gray-100 animate-pulse" />
                                <SkeletonLine className="h-4 w-32" />
                            </div>
                            {Array.from({ length: SKELETON_COLS }).map((_, col) => (
                                <div
                                    key={col}
                                    className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2`}
                                >
                                    <SkeletonLine className="h-4" />
                                </div>
                            ))}
                            <div className="flex-1 border-b border-gray-200 min-w-8" />
                        </div>
                    ))}
            </TableScrollArea>
        );
    }

    if (
        columns.length === 0 &&
        rows.length === 0 &&
        uploadingFilenames.length === 0
    ) {
        return (
            <TableScrollArea
                preserveGridBorder
                className={TR_GUTTER_CLASS}
                header={
                    <div className="shrink-0 flex h-10 items-center border-b border-gray-200">
                        <div
                            className={`${DOC_COL_W} ${TR_STICKY_CELL_CLASS} flex items-center border-r border-gray-200 py-2 pl-3 pr-2 text-xs font-medium text-gray-700 select-none`}
                        >
                            {firstColumnLabel}
                        </div>
                        <div className="flex-1" />
                    </div>
                }
            >
                <div className="relative flex min-h-0 flex-1">
                    {dragOverFiles && (
                        <div className="absolute inset-0 z-[90] border-2 border-blue-400 bg-blue-50/40 pointer-events-none" />
                    )}
                    <EmptyState
                        className="mx-auto w-full max-w-xs flex-1 justify-center"
                        icon={<TabularReviewSkeuoIcon />}
                        title="Tabular Review"
                        description="Add columns and documents to get started."
                        action={
                            <div className="flex items-center gap-2">
                                <PillButtonUI
                                    tone="black"
                                    size="sm"
                                    onClick={onAddColumn}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Add Columns
                                </PillButtonUI>
                                <PillButtonUI
                                    tone="white"
                                    size="sm"
                                    onClick={onAddDocuments}
                                >
                                    <Upload className="h-3.5 w-3.5" />
                                    Add Documents
                                </PillButtonUI>
                            </div>
                        }
                    />
                </div>
            </TableScrollArea>
        );
    }

    return (
        <TableScrollArea
            preserveGridBorder
            className={TR_GUTTER_CLASS}
            scrollRef={scrollContainerRef}
            onScroll={handleRowsScroll}
            header={
                <div
                    className="z-[70] flex h-10 shrink-0"
                    style={{ minWidth: totalContentWidth }}
                >
                    <div
                        className={`sticky left-0 z-[80] ${DOC_COL_W} ${TR_STICKY_CELL_CLASS} border-b border-r border-gray-200 flex items-center py-2 pl-3 pr-2 text-left text-xs font-medium text-gray-700 select-none`}
                    >
                        <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(el) => {
                                if (el) el.indeterminate = someSelected;
                            }}
                            onChange={toggleAll}
                            className={TABLE_CHECKBOX_CLASS}
                            aria-label={`Select all ${firstColumnLabel.toLowerCase()}`}
                        />
                        <span>{firstColumnLabel}</span>
                    </div>
                    {columns.map((col) => (
                        <div
                            key={col.index}
                            data-tr-col-header
                            className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2 text-left text-xs font-medium text-gray-700 select-none`}
                        >
                            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span className="truncate">{col.name}</span>
                                <TREditColumnMenu
                                    column={col}
                                    closeSignal={scrollCloseSignal}
                                    disabled={savingColumn || savingColumnsConfig}
                                    onSave={onUpdateColumn}
                                    onDelete={onDeleteColumn}
                                />
                            </div>
                        </div>
                    ))}
                    <div className="flex-1 border-b border-gray-200 flex items-center justify-start p-2 min-w-8">
                        <button
                            onClick={onAddColumn}
                            disabled={savingColumn || savingColumnsConfig}
                            className="flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors disabled:text-gray-200"
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            }
        >
                <div className="relative min-h-0 flex-1">
                    {dragOverFiles && (
                        <div className="absolute inset-0 z-[90] border-2 border-blue-400 bg-blue-50/40 pointer-events-none" />
                    )}
                    {uploadingFilenames.map((filename) => (
                    <div
                        key={`uploading-${filename}`}
                        className="flex h-8"
                        style={{ minWidth: totalContentWidth }}
                    >
                        <div
                            className={`${TR_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_COL_W} border-b border-r border-gray-200 py-2 pl-3 pr-2 text-xs text-gray-400 flex items-center`}
                        >
                            <input
                                type="checkbox"
                                disabled
                                className="mr-3 h-2.5 w-2.5 shrink-0 rounded border-gray-200 cursor-default accent-black disabled:opacity-100"
                                aria-label={`Select ${filename}`}
                            />
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin shrink-0" />
                            <span className="line-clamp-1" title={filename}>
                                {filename}
                            </span>
                        </div>
                        {sortedColumns.map((col) => (
                            <div
                                key={col.index}
                                className={`${COL_W} border-b border-r border-gray-200 p-2`}
                            >
                                <SkeletonLine className="h-4 w-20" />
                            </div>
                        ))}
                        <div className="flex-1 border-b border-gray-200 min-h-8 min-w-8" />
                    </div>
                    ))}
                    {rows.map((row, rowIdx) => {
                    const isSelected = selectedRowIds.includes(row.id);
                    const sourceDocuments = row.source_document_ids
                        .map((documentId) => documentsById.get(documentId))
                        .filter(
                            (document): document is Document => !!document,
                        );
                    const rowBg = isSelected
                        ? LIQUID_GLASS_SELECTED_CLASS
                        : LIQUID_GLASS_HOVER_CLASS;
                    const stickyRowBg = isSelected
                        ? LIQUID_GLASS_SELECTED_CLASS
                        : "";
                    return (
                        <div
                            key={row.id}
                            className={`group flex transition-colors ${rowBg}`}
                            style={{ minWidth: totalContentWidth }}
                        >
                            <TRFirstColumnCell
                                row={row}
                                sourceDocuments={sourceDocuments}
                                selected={isSelected}
                                closeSignal={scrollCloseSignal}
                                onToggleSelection={() => toggleRow(row.id)}
                                onDocumentOpen={(document) =>
                                    onDocumentOpen(row, document)
                                }
                                className={`${TR_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_COL_W} border-b border-r border-gray-200 py-2 pl-3 pr-2 text-xs text-gray-800 flex items-center transition-colors ${stickyRowBg} ${isSelected ? "" : LIQUID_GLASS_GROUP_HOVER_CLASS}`}
                            />
                            {columns.map((col) => {
                                const cell = getCell(row, col.index);
                                const colPos = sortedColumns.findIndex(
                                    (c) => c.index === col.index,
                                );
                                const isHighlighted =
                                    highlightedCell?.colIdx === colPos &&
                                    highlightedCell?.rowIdx === rowIdx;
                                return (
                                    <div
                                        key={col.index}
                                        className={`${COL_W} border-b border-r border-gray-200 transition-colors ${isHighlighted ? "bg-blue-200" : ""}`}
                                    >
                                        {cell && (
                                            <TabularCellComponent
                                                cell={cell}
                                                column={col}
                                                closeSignal={scrollCloseSignal}
                                                onExpand={() => onExpand(cell)}
                                                onCitationClick={(
                                                    page,
                                                    quote,
                                                    citationRef,
                                                    sheet,
                                                    citationCell,
                                                    documentId,
                                                ) =>
                                                    onCitationClick(
                                                        cell,
                                                        page,
                                                        quote,
                                                        citationRef,
                                                        sheet,
                                                        citationCell,
                                                        documentId,
                                                    )
                                                }
                                            />
                                        )}
                                    </div>
                                );
                            })}
                            <div className="flex-1 border-b border-gray-200 min-h-8 min-w-8" />
                        </div>
                    );
                    })}
                </div>
        </TableScrollArea>
    );
});
