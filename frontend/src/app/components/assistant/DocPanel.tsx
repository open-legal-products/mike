"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PdfView } from "../shared/views/PdfView";
import { DocxView } from "../shared/views/DocxView";
import type { DocxSaveState } from "../shared/views/DocxRenderer.types";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import {
    CitationQuotesSection,
    documentQuoteId,
} from "./CitationQuotesSection";
import { EditCard } from "./EditCard";
import { expandDocumentQuoteEntry } from "../shared/types";
import type { Citation, EditAnnotation, PanelDocument } from "../shared/types";
import { quoteVerificationState } from "./message/citationVerification";
import { CaseView } from "./CaseView";
import { useResolvedPanelDocument } from "./useResolvedPanelDocument";
import { DocumentTitleRow } from "../shared/DocumentTitleRow";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";

export { DocumentTitleRow } from "../shared/DocumentTitleRow";

/**
 * Discriminated-union describing what the panel is showing above the viewer.
 *   - "document":  title row + viewer.
 *   - "citation":  title row + relevant quote + viewer.
 *   - "edit":      title row + tracked change + viewer.
 */
export type DocPanelMode =
    | { kind: "document" }
    | { kind: "citation"; citation: Citation }
    | {
          kind: "edit";
          edit: EditAnnotation;
          changeNumber?: number;
          /**
           * True while an accept/reject request for this exact edit is in
           * flight. Scoped per-edit (not per-document) so sibling edits on
           * the same doc stay clickable.
           */
          isEditReloading?: boolean;
          onResolveStart?: (args: {
              editId: string;
              documentId: string;
              verb: "accept" | "reject";
          }) => void;
          onResolved?: (args: {
              editId: string;
              documentId: string;
              status: "accepted" | "rejected";
              versionId: string | null;
              downloadUrl: string | null;
          }) => void;
          onError?: (args: {
              editId: string;
              documentId: string;
              versionId: string | null;
              message: string;
          }) => void;
      };

interface Props {
    document: PanelDocument;
    mode: DocPanelMode;
    isReloading?: boolean;
    compactActions?: boolean;
    active?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    /**
     * Dismisses the citation quote / tracked change shown above the viewer,
     * leaving the document itself open. The host owns this because the mode
     * comes from the tab: hiding the section locally would strand the user if
     * they reopened the same citation, which produces no prop change.
     */
    onCloseAnnotation?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
    onDownloadReady?: (download: (() => Promise<void>) | null) => void;
}

/** One shared panel shell with a document-type-specific body. */
export function DocPanel({
    document,
    mode,
    isReloading = false,
    compactActions = false,
    active = true,
    warning,
    onWarningDismiss,
    onCloseAnnotation,
    initialScrollTop,
    onScrollChange,
    onDownloadReady,
}: Props) {
    const [saveState, setSaveState] = useState<DocxSaveState | null>(null);
    const onSaveStateChange = useCallback((_documentId: string, state: DocxSaveState | null) => setSaveState(state), []);
    const localDownload = useRef<(() => Promise<void>) | null>(null);
    const handleDownloadReady = useCallback((download: (() => Promise<void>) | null) => {
        localDownload.current = download;
        onDownloadReady?.(download);
    }, [onDownloadReady]);
    const {
        document: resolvedDocument,
        isLoading: isDocumentLoading,
        error: documentError,
        retry: retryDocument,
    } = useResolvedPanelDocument(document);

    const documentId = resolvedDocument.document_id;
    const versionId = resolvedDocument.version_id ?? null;
    const isCase = resolvedDocument.type === "case";
    const viewType = resolveDocumentViewType({
        filename: resolvedDocument.title,
        fileType: resolvedDocument.type,
    });
    const firstSelectableQuoteIndex =
        mode.kind === "citation"
            ? resolvedDocument.quotes.findIndex(
                  (quote) => quoteVerificationState(quote) !== "unverified",
              )
            : -1;
    const citationQuoteId =
        firstSelectableQuoteIndex >= 0
            ? documentQuoteId(documentId, firstSelectableQuoteIndex)
            : null;
    const [activeCitationQuoteId, setActiveCitationQuoteId] = useState<
        string | null
    >(citationQuoteId);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const [editFocusKey, setEditFocusKey] = useState(0);

    const activeQuoteIndex = activeCitationQuoteId
        ? Number(activeCitationQuoteId.split(":quote:").at(-1))
        : Number.NaN;
    const activeDocumentQuote = Number.isFinite(activeQuoteIndex)
        ? resolvedDocument.quotes[activeQuoteIndex]
        : undefined;

    const { activeViewerQuotes, activeHighlightCells } = useMemo(() => {
        if (mode.kind !== "citation" || isCase) {
            return {
                activeViewerQuotes: undefined,
                activeHighlightCells: undefined,
            };
        }
        if (!activeDocumentQuote) {
            return {
                activeViewerQuotes: [],
                activeHighlightCells: [],
            };
        }

        return {
            activeViewerQuotes: expandDocumentQuoteEntry({
                page: activeDocumentQuote.target.page,
                quote: activeDocumentQuote.quote,
            }),
            activeHighlightCells:
                activeDocumentQuote.target.cell ||
                activeDocumentQuote.target.sheet
                    ? [
                          {
                              sheet: activeDocumentQuote.target.sheet,
                              cell: activeDocumentQuote.target.cell,
                          },
                      ]
                    : [],
        };
    }, [activeDocumentQuote, isCase, mode.kind]);

    useEffect(() => {
        setActiveCitationQuoteId(citationQuoteId);
    }, [citationQuoteId]);

    const handleCitationQuoteSelect = useCallback(
        (quoteId: string) => {
            const shouldSelect = activeCitationQuoteId !== quoteId;
            setActiveCitationQuoteId(shouldSelect ? quoteId : null);
            if (shouldSelect) setQuoteFocusKey((current) => current + 1);
        },
        [activeCitationQuoteId],
    );

    const highlightEdit = useMemo(() => {
        if (mode.kind !== "edit") return null;
        return {
            key: `${mode.edit.edit_id}:${editFocusKey}`,
            inserted_text: mode.edit.inserted_text,
            deleted_text: mode.edit.deleted_text,
            ins_w_id: mode.edit.ins_w_id ?? null,
            del_w_id: mode.edit.del_w_id ?? null,
        };
    }, [editFocusKey, mode]);

    return (
        <div className="flex h-full flex-col">
            <DocumentTitleRow
                document={resolvedDocument}
                isReloading={isReloading}
                compactActions={compactActions}
                saveState={saveState}
                onDownload={() => localDownload.current?.()}
            />

            {mode.kind === "citation" && (
                <CitationQuotesSection
                    document={resolvedDocument}
                    activeQuoteId={activeCitationQuoteId}
                    citationRef={mode.citation.ref}
                    onSelect={(quote) => {
                        if (quote.verificationState !== "unverified") {
                            handleCitationQuoteSelect(quote.id);
                        }
                    }}
                    onIndexChange={(index) => {
                        handleCitationQuoteSelect(
                            documentQuoteId(documentId, index),
                        );
                    }}
                    onClose={onCloseAnnotation}
                />
            )}

            {mode.kind === "edit" && !isCase && (
                <div className="px-2 pb-2">
                    <EditCard
                        annotation={mode.edit}
                        changeNumber={mode.changeNumber}
                        isReloading={mode.isEditReloading}
                        onResolveStart={mode.onResolveStart}
                        onResolved={mode.onResolved}
                        onError={mode.onError}
                        onViewClick={() =>
                            setEditFocusKey((current) => current + 1)
                        }
                        onClose={onCloseAnnotation}
                    />
                </div>
            )}

            <div className="flex flex-1 min-h-0 flex-col">
                {isCase ? (
                    <CaseView
                        document={resolvedDocument}
                        activeQuote={activeDocumentQuote}
                        quoteFocusKey={quoteFocusKey}
                        isLoading={isDocumentLoading}
                        error={documentError}
                        onRetry={retryDocument}
                        onClearQuote={() => setActiveCitationQuoteId(null)}
                    />
                ) : viewType === "docx" ? (
                    <DocxView
                        onDownloadReady={handleDownloadReady}
                        onSaveStateChange={onSaveStateChange}
                        defaultMode="edit"
                        filename={resolvedDocument.title}
                        documentId={documentId}
                        versionId={versionId ?? undefined}
                        rounded={false}
                        quotes={activeViewerQuotes}
                        quoteFocusKey={quoteFocusKey}
                        highlightEdit={highlightEdit}
                        warning={warning ?? null}
                        onWarningDismiss={onWarningDismiss}
                        initialScrollTop={initialScrollTop ?? null}
                        onScrollChange={onScrollChange}
                    />
                ) : viewType === "spreadsheet" ? (
                    <SpreadsheetView
                        active={active}
                        documentId={documentId}
                        versionId={versionId}
                        rounded={false}
                        highlightCells={activeHighlightCells}
                    />
                ) : (
                    <PdfView
                        doc={{
                            document_id: documentId,
                            version_id: versionId,
                        }}
                        rounded={false}
                        quotes={activeViewerQuotes}
                        quoteFocusKey={quoteFocusKey}
                    />
                )}
            </div>
        </div>
    );
}
