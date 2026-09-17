"use client";

import {
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Loader2,
    PanelLeft,
    RefreshCw,
    X,
} from "lucide-react";
import type {
    ColumnConfig,
    Document,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";
import { PdfView } from "../shared/views/PdfView";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import { DocxView } from "../shared/views/DocxView";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { SubfolderSvgIcon } from "../shared/FolderSvgIcon";
import { CitationQuotesSection } from "../assistant/CitationQuotesSection";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_PRESSED_CLASS,
    LIQUID_FLOAT_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { GlassIconButtonUI } from "@/shared/ui/GlassIconButtonUI";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";

interface Props {
    cell: TabularCell;
    row: TabularReviewRow;
    rows: TabularReviewRow[];
    document?: Document;
    documents?: Document[];
    column: ColumnConfig;
    columns: ColumnConfig[];
    onClose: () => void;
    onNavigate: (rowId: string, columnIndex: number) => void;
    onRegenerate?: () => Promise<void>;
    /** If true, open the document panel immediately */
    displayDocument?: boolean;
    /** Show document metadata instead of analysis details. */
    documentOnly?: boolean;
    /** Quote to highlight when opening document panel */
    citationQuote?: string;
    /** Page to scroll to when opening document panel */
    citationPage?: number;
    /** Spreadsheet worksheet containing the cited cell */
    citationSheet?: string;
    /** Spreadsheet A1 cell address or range */
    citationCell?: string;
    /** Source document encoded in a grouped-row citation. */
    citationDocumentId?: string;
    /** One-based citation number shown in the cell content */
    citationRef?: number;
}

type TRPanelCitation = {
    documentId?: string;
    quote: string;
    page?: number;
    sheet?: string;
    cell?: string;
    citationRef?: number;
};

const FLAG_BADGE: Record<string, string> = {
    green: "bg-emerald-600 backdrop-blur-md border border-emerald-300/20 text-white shadow-md",
    grey: "bg-slate-500 backdrop-blur-md border border-slate-300/20 text-white shadow-md",
    yellow: "bg-amber-500 backdrop-blur-md border border-amber-300/20 text-white shadow-md",
    red: "bg-red-600 backdrop-blur-md border border-red-300/20 text-white shadow-md",
};

const MIN_DOCUMENT_PANE_WIDTH = 420;
const DEFAULT_DOCUMENT_PANE_WIDTH = 600;
const MAX_DOCUMENT_PANE_WIDTH = 1000;
const INFO_PANE_WIDTH = 300;

// ---------------------------------------------------------------------------
// TRSidePanel
// ---------------------------------------------------------------------------

export function TRSidePanel({
    cell,
    row,
    rows,
    document: initialDocument,
    documents = [],
    column,
    columns,
    onClose,
    onNavigate,
    onRegenerate,
    displayDocument = false,
    documentOnly = false,
    citationQuote,
    citationPage,
    citationSheet,
    citationCell,
    citationDocumentId,
    citationRef,
}: Props) {
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const currentPos = sortedColumns.findIndex((c) => c.index === column.index);
    const previousColumn =
        currentPos > 0 ? sortedColumns[currentPos - 1] : null;
    const nextColumn =
        currentPos >= 0 && currentPos < sortedColumns.length - 1
            ? sortedColumns[currentPos + 1]
            : null;
    const currentRowPos = rows.findIndex(
        (candidate) => candidate.id === row.id,
    );
    const previousRow = currentRowPos > 0 ? rows[currentRowPos - 1] : null;
    const nextRow =
        currentRowPos >= 0 && currentRowPos < rows.length - 1
            ? rows[currentRowPos + 1]
            : null;
    const sourceDocuments = row.source_document_ids.flatMap((documentId) => {
        const sourceDocument = documents.find(
            (document) => document.id === documentId,
        );
        return sourceDocument ? [sourceDocument] : [];
    });
    const [regenerating, setRegenerating] = useState(false);
    const [folderExpanded, setFolderExpanded] = useState(false);
    const [activeDocumentId, setActiveDocumentId] = useState(
        citationDocumentId ?? initialDocument?.id,
    );
    const doc =
        documents.find(
            (document) =>
                document.id === activeDocumentId &&
                row.source_document_ids.includes(document.id),
        ) ?? initialDocument;
    const activeVersionNumber =
        doc?.active_version_number ?? doc?.latest_version_number ?? 1;
    const documentViewType = resolveDocumentViewType({
        filename: doc?.filename,
        fileType: doc?.file_type,
        preferPdfForWord: Boolean(doc?.pdf_storage_path),
    });
    const [documentPaneOpen, setDocumentPaneOpen] = useState(
        displayDocument && !!doc,
    );
    const [documentPaneWidth, setDocumentPaneWidth] = useState(
        DEFAULT_DOCUMENT_PANE_WIDTH,
    );
    const panelRef = useRef<HTMLDivElement>(null);
    const resizePointerId = useRef<number | null>(null);
    const resizeStartX = useRef(0);
    const resizeStartWidth = useRef(DEFAULT_DOCUMENT_PANE_WIDTH);

    // Internal state — initialised from props, also toggled by badge clicks inside the panel
    const [docCitation, setDocCitation] = useState<TRPanelCitation | undefined>(
        displayDocument && citationQuote
            ? {
                  quote: citationQuote,
                  page: citationPage,
                  sheet: citationSheet,
                  cell: citationCell,
                  documentId: citationDocumentId,
                  citationRef,
              }
            : undefined,
    );

    // Re-sync when the panel opens for a different cell or citation
    useEffect(() => {
        setDocCitation(
            displayDocument && citationQuote
                ? {
                      quote: citationQuote,
                      page: citationPage,
                      sheet: citationSheet,
                      cell: citationCell,
                      documentId: citationDocumentId,
                      citationRef,
                  }
                : undefined,
        );
        const nextDocument = citationDocumentId
            ? documents.find(
                  (document) =>
                      document.id === citationDocumentId &&
                      row.source_document_ids.includes(document.id),
              )
            : initialDocument;
        setActiveDocumentId(nextDocument?.id);
        setDocumentPaneOpen(displayDocument && !!nextDocument);
    }, [
        cell.id,
        displayDocument,
        citationCell,
        citationDocumentId,
        citationPage,
        citationQuote,
        citationRef,
        citationSheet,
        documents,
        initialDocument,
        row,
    ]);

    useEffect(
        () => () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        },
        [],
    );

    useEffect(() => {
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (
                !(target instanceof Node) ||
                panelRef.current?.contains(target)
            ) {
                return;
            }
            onClose();
        };

        document.addEventListener("pointerdown", handleOutsidePointerDown);
        return () =>
            document.removeEventListener(
                "pointerdown",
                handleOutsidePointerDown,
            );
    }, [onClose]);

    function handleDocumentResizePointerDown(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        event.preventDefault();
        resizePointerId.current = event.pointerId;
        resizeStartX.current = event.clientX;
        resizeStartWidth.current = documentPaneWidth;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    function handleDocumentResizePointerMove(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        if (resizePointerId.current !== event.pointerId) return;

        const viewportMax = window.innerWidth - INFO_PANE_WIDTH - 2 * 12 - 24;
        const maxWidth = Math.max(
            MIN_DOCUMENT_PANE_WIDTH,
            Math.min(MAX_DOCUMENT_PANE_WIDTH, viewportMax),
        );
        const nextWidth =
            resizeStartWidth.current + (resizeStartX.current - event.clientX);

        setDocumentPaneWidth(
            Math.min(maxWidth, Math.max(MIN_DOCUMENT_PANE_WIDTH, nextWidth)),
        );
    }

    function handleDocumentResizePointerEnd(
        event: ReactPointerEvent<HTMLDivElement>,
    ) {
        if (resizePointerId.current !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        resizePointerId.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    }

    function handleCitationOpen(citation: TRPanelCitation) {
        setDocCitation(citation);
        const citedDocument = citation.documentId
            ? documents.find(
                  (document) =>
                      document.id === citation.documentId &&
                      row.source_document_ids.includes(document.id),
              )
            : doc;
        if (citedDocument) {
            setActiveDocumentId(citedDocument.id);
            setDocumentPaneOpen(true);
        }
    }

    function handleSourceDocumentOpen(sourceDocument: Document) {
        setActiveDocumentId(sourceDocument.id);
        setDocCitation(undefined);
        setDocumentPaneOpen(true);
    }

    const { processed: summaryText, citations: summaryCitations } =
        preprocessCitations(cell.content?.summary ?? "");
    const { processed: reasoningText, citations: reasoningCitations } =
        preprocessCitations(cell.content?.reasoning ?? "");

    return (
        <div
            ref={panelRef}
            className={cn(
                "fixed z-100 flex flex-row",
                LIQUID_FLOAT_PANEL_SURFACE_CLASS,
                "right-3 top-3 bottom-3 overflow-hidden",
            )}
        >
            {/* Resizable document panel — left */}
            {documentPaneOpen && doc && (
                <div
                    className="relative flex shrink-0 flex-col border-r border-white/30 px-3 pb-3"
                    style={{ width: documentPaneWidth }}
                >
                    <div
                        onPointerDown={handleDocumentResizePointerDown}
                        onPointerMove={handleDocumentResizePointerMove}
                        onPointerUp={handleDocumentResizePointerEnd}
                        onPointerCancel={handleDocumentResizePointerEnd}
                        className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-blue-400/60"
                        title="Resize document pane"
                    />
                    {/* Doc header */}
                    <div className="flex min-h-11 shrink-0 items-center gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <FileTypeIcon
                                fileType={doc.file_type ?? doc.filename}
                                className="h-4 w-4"
                            />
                            <div
                                className="min-w-0 truncate text-sm font-medium text-gray-700"
                                title={doc.filename}
                            >
                                {doc.filename}
                            </div>
                        </div>
                    </div>
                    {/* Quote row */}
                    {docCitation?.quote && (
                        <div className="-mx-3 shrink-0 py-2">
                            <CitationQuotesSection
                                quotes={[
                                    {
                                        id: citationKey(cell.id, docCitation),
                                        quote: docCitation.quote,
                                        quoteLabel:
                                            formatCitationLocation(docCitation),
                                    },
                                ]}
                                activeQuoteId={citationKey(
                                    cell.id,
                                    docCitation,
                                )}
                                citationRef={docCitation.citationRef}
                            />
                        </div>
                    )}
                    {documentViewType === "docx" ? (
                        <DocxView
                            documentId={doc.id}
                            quotes={
                                docCitation
                                    ? [
                                          {
                                              page: docCitation.page,
                                              quote: docCitation.quote,
                                          },
                                      ]
                                    : undefined
                            }
                        />
                    ) : documentViewType === "spreadsheet" ? (
                        <SpreadsheetView
                            documentId={doc.id}
                            highlightCells={
                                docCitation?.sheet || docCitation?.cell
                                    ? [
                                          {
                                              sheet: docCitation.sheet,
                                              cell: docCitation.cell,
                                          },
                                      ]
                                    : undefined
                            }
                        />
                    ) : (
                        <PdfView
                            doc={{ document_id: doc.id }}
                            quote={docCitation?.quote}
                            fallbackPage={docCitation?.page}
                        />
                    )}
                </div>
            )}

            {/* Info column — right, 300px fixed */}
            <div className="flex w-[300px] shrink-0 flex-col overflow-hidden">
                {/* Header */}
                <div className="mb-2 flex min-h-11 shrink-0 items-center justify-end gap-1.5 px-3">
                    {doc && (
                        <button
                            type="button"
                            onClick={() => setDocumentPaneOpen((open) => !open)}
                            className={cn(
                                "mr-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/75 hover:text-gray-700",
                                documentPaneOpen && "bg-white/55 text-gray-700",
                            )}
                            aria-label={
                                documentPaneOpen
                                    ? "Collapse document pane"
                                    : "Expand document pane"
                            }
                            title={
                                documentPaneOpen
                                    ? "Collapse document pane"
                                    : "Expand document pane"
                            }
                            aria-pressed={documentPaneOpen}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </button>
                    )}
                    {!documentOnly && onRegenerate && (
                        <button
                            type="button"
                            onClick={async () => {
                                setRegenerating(true);
                                try {
                                    await onRegenerate();
                                } finally {
                                    setRegenerating(false);
                                }
                            }}
                            disabled={regenerating}
                            title="Regenerate"
                            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40"
                        >
                            {regenerating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </button>
                    )}
                    <GlassIconButtonUI onClick={onClose} aria-label="Close">
                        <X className="h-3.5 w-3.5" />
                    </GlassIconButtonUI>
                </div>

                {/* Analysis panel */}
                <div className="flex-1 overflow-y-auto">
                    <div className="pb-2 px-5">
                        {documentOnly ? (
                            <>
                                <div className="mb-4">
                                    <div className="mb-3 text-xs font-medium text-gray-900">
                                        Document
                                    </div>
                                    <div className="flex min-h-6 items-center gap-1.5">
                                        <FileTypeIcon
                                            fileType={
                                                doc?.file_type ?? doc?.filename
                                            }
                                            className="h-3 w-3 shrink-0"
                                        />
                                        <div
                                            className="min-w-0 flex-1 truncate text-xs leading-6 text-gray-800"
                                            title={doc?.filename}
                                        >
                                            {doc?.filename ?? row.label}
                                        </div>
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-3 text-xs font-medium text-gray-900">
                                        Version
                                    </div>
                                    <div className="min-h-6 text-xs leading-6 text-gray-800">
                                        V{activeVersionNumber}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                {/* Document field */}
                                <div className="mb-4">
                                    <div className="mb-3 text-xs font-medium text-gray-900">
                                        {row.row_type === "folder"
                                            ? "Folder"
                                            : "Document"}
                                    </div>
                                    {row.row_type === "folder" ? (
                                        <div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setFolderExpanded(
                                                        (expanded) => !expanded,
                                                    )
                                                }
                                                className={cn(
                                                    "flex min-h-6 w-full items-center gap-1.5 rounded-md px-1 text-left text-gray-800 transition-colors",
                                                    LIQUID_GLASS_HOVER_CLASS,
                                                    LIQUID_GLASS_PRESSED_CLASS,
                                                )}
                                                aria-expanded={folderExpanded}
                                            >
                                                <SubfolderSvgIcon
                                                    open={folderExpanded}
                                                    className="h-3 w-3 shrink-0"
                                                />
                                                <span
                                                    className="min-w-0 flex-1 truncate text-xs leading-6"
                                                    title={row.label}
                                                >
                                                    {row.label}
                                                </span>
                                                <ChevronDown
                                                    className={cn(
                                                        "h-3 w-3 shrink-0 text-gray-500 transition-transform",
                                                        folderExpanded &&
                                                            "rotate-180",
                                                    )}
                                                />
                                            </button>
                                            {folderExpanded && (
                                                <div className="mt-1">
                                                    {sourceDocuments.map(
                                                        (sourceDocument) => (
                                                            <button
                                                                key={
                                                                    sourceDocument.id
                                                                }
                                                                type="button"
                                                                onClick={() =>
                                                                    handleSourceDocumentOpen(
                                                                        sourceDocument,
                                                                    )
                                                                }
                                                                className={cn(
                                                                    "flex min-h-6 w-full items-center gap-1.5 rounded-md py-1 pl-5 pr-1 text-left text-xs text-gray-800 transition-colors",
                                                                    LIQUID_GLASS_HOVER_CLASS,
                                                                    LIQUID_GLASS_PRESSED_CLASS,
                                                                )}
                                                                title={
                                                                    sourceDocument.filename
                                                                }
                                                            >
                                                                <FileTypeIcon
                                                                    fileType={
                                                                        sourceDocument.file_type ??
                                                                        sourceDocument.filename
                                                                    }
                                                                    className="h-3 w-3 shrink-0"
                                                                />
                                                                <span className="min-w-0 flex-1 truncate">
                                                                    {
                                                                        sourceDocument.filename
                                                                    }
                                                                </span>
                                                            </button>
                                                        ),
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="flex min-h-6 items-center gap-1.5">
                                            <FileTypeIcon
                                                fileType={
                                                    doc?.file_type ??
                                                    doc?.filename
                                                }
                                                className="h-3 w-3"
                                            />
                                            <div
                                                className="min-w-0 flex-1 truncate text-xs leading-6 text-gray-800"
                                                title={row.label}
                                            >
                                                {row.label}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Column field */}
                                <div className="mb-4">
                                    <div className="mb-3 text-xs font-medium text-gray-900">
                                        Column
                                    </div>
                                    <div className="min-h-6 truncate text-xs leading-6 text-gray-800">
                                        {column.name}
                                    </div>
                                </div>

                                {/* Flag section */}
                                {cell.content?.flag && (
                                    <div className="mb-5">
                                        <h4 className="mb-2 text-xs font-medium text-gray-900">
                                            Flag
                                        </h4>
                                        <span
                                            className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${FLAG_BADGE[cell.content.flag] ?? FLAG_BADGE.grey}`}
                                        >
                                            {cell.content.flag
                                                .charAt(0)
                                                .toUpperCase() +
                                                cell.content.flag.slice(1)}
                                        </span>
                                    </div>
                                )}

                                {/* Results */}
                                <div className="mb-6">
                                    <h4 className="mb-2 text-xs font-medium text-gray-900">
                                        Results
                                    </h4>
                                    <div className="text-xs leading-relaxed text-gray-700">
                                        <MarkdownContent
                                            citations={summaryCitations}
                                            onCitationClick={handleCitationOpen}
                                            column={column}
                                        >
                                            {summaryText || "—"}
                                        </MarkdownContent>
                                    </div>
                                </div>

                                {/* Reasoning */}
                                {cell.content?.reasoning && (
                                    <div>
                                        <h4 className="mb-2 text-xs font-medium text-gray-900">
                                            Reasoning
                                        </h4>
                                        <div className="text-xs leading-relaxed text-gray-700">
                                            <MarkdownContent
                                                citations={reasoningCitations}
                                                onCitationClick={
                                                    handleCitationOpen
                                                }
                                                citationOffset={
                                                    summaryCitations.length
                                                }
                                                column={column}
                                                inline
                                            >
                                                {reasoningText}
                                            </MarkdownContent>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
                {!documentOnly && (
                    <div className="flex shrink-0 justify-center bg-white/25 pb-7 pt-1">
                        <div className="grid grid-cols-3 grid-rows-3 gap-0.5">
                            <CellNavigatorButton
                                className="col-start-2 row-start-1"
                                label="Previous row"
                                title={previousRow?.label}
                                disabled={!previousRow}
                                onClick={() =>
                                    previousRow &&
                                    onNavigate(previousRow.id, column.index)
                                }
                            >
                                <ChevronUp className="h-4 w-4" />
                            </CellNavigatorButton>
                            <CellNavigatorButton
                                className="col-start-1 row-start-2"
                                label="Previous column"
                                title={previousColumn?.name}
                                disabled={!previousColumn}
                                onClick={() =>
                                    previousColumn &&
                                    onNavigate(row.id, previousColumn.index)
                                }
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </CellNavigatorButton>
                            <div className="col-start-2 row-start-2 h-7 w-7 rounded-md bg-white/35" />
                            <CellNavigatorButton
                                className="col-start-3 row-start-2"
                                label="Next column"
                                title={nextColumn?.name}
                                disabled={!nextColumn}
                                onClick={() =>
                                    nextColumn &&
                                    onNavigate(row.id, nextColumn.index)
                                }
                            >
                                <ChevronRight className="h-4 w-4" />
                            </CellNavigatorButton>
                            <CellNavigatorButton
                                className="col-start-2 row-start-3"
                                label="Next row"
                                title={nextRow?.label}
                                disabled={!nextRow}
                                onClick={() =>
                                    nextRow &&
                                    onNavigate(nextRow.id, column.index)
                                }
                            >
                                <ChevronDown className="h-4 w-4" />
                            </CellNavigatorButton>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function CellNavigatorButton({
    label,
    title,
    disabled,
    onClick,
    className,
    children,
}: {
    label: string;
    title?: string;
    disabled: boolean;
    onClick: () => void;
    className?: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={title ? `${label}: ${title}` : label}
            className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors disabled:cursor-default disabled:opacity-25",
                LIQUID_GLASS_HOVER_CLASS,
                LIQUID_GLASS_PRESSED_CLASS,
                className,
            )}
        >
            {children}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function formatCitationLocation(citation: ParsedCitation): string {
    if (citation.sheet && citation.cell) {
        return `${citation.sheet}, cell ${citation.cell}`;
    }
    return `Page ${citation.page ?? 1}`;
}

function citationKey(cellId: string, citation: ParsedCitation): string {
    const location = citation.sheet
        ? `${citation.sheet}:${citation.cell ?? ""}`
        : `page:${citation.page ?? 1}`;
    return `tr-cell:${cellId}:${citation.documentId ?? "document"}:${location}`;
}

function CitationBadge({
    index,
    citation,
    onClick,
}: {
    index: number;
    citation: ParsedCitation;
    onClick: (citation: TRPanelCitation) => void;
}) {
    return (
        <CitationPillUI
            data-page={citation.page}
            data-sheet={citation.sheet}
            data-cell={citation.cell}
            data-document-id={citation.documentId}
            data-quote={citation.quote}
            title={`${formatCitationLocation(citation)}: "${citation.quote}"`}
            onClick={() =>
                onClick({
                    quote: citation.quote,
                    page: citation.page,
                    sheet: citation.sheet,
                    cell: citation.cell,
                    documentId: citation.documentId,
                    citationRef: index + 1,
                })
            }
            className="align-super"
        >
            {index + 1}
        </CitationPillUI>
    );
}

function MarkdownContent({
    children,
    citations,
    onCitationClick,
    citationOffset = 0,
    column,
    inline,
}: {
    children: string;
    citations: ParsedCitation[];
    onCitationClick: (citation: TRPanelCitation) => void;
    inline?: boolean;
    citationOffset?: number;
    column?: ColumnConfig;
}) {
    if (!children) return null;

    const pills: string[] = [];
    let processed = children.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\``;
    });
    processed = processed.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\``);

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p
                            className="mb-1.5 last:mb-0 leading-relaxed"
                            {...props}
                        />
                    ),
                ul: ({ node, ...props }) => (
                    <ul
                        className="list-disc pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                ol: ({ node, ...props }) => (
                    <ol
                        className="list-decimal pl-4 space-y-0.5 mb-1.5 last:mb-0"
                        {...props}
                    />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => (
                    <em className="italic" {...props} />
                ),
                a: ({ node, href, children, ...props }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700 underline"
                        {...props}
                    >
                        {children}
                    </a>
                ),
                code: ({ node, children: codeChildren, ...props }) => {
                    const t = String(codeChildren);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <CitationBadge
                                    index={citationOffset + idx}
                                    citation={citation}
                                    onClick={onCitationClick}
                                />
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-gray-100 px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {codeChildren}
                        </code>
                    );
                },
            }}
        >
            {processed}
        </ReactMarkdown>
    );
}
