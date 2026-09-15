"use client";

import { memo, type ComponentProps } from "react";
import { ProjectWorkspaceTips } from "./ProjectWorkspaceTips";
import type { CitationQuote, Document } from "@/app/components/shared/types";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { SpreadsheetView } from "@/app/components/shared/views/SpreadsheetView";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import { cn } from "@/app/lib/utils";

export type ProjectDocumentTab = {
    documentId: string;
    filename: string;
    fileType?: string | null;
    versionId?: string | null;
    warning?: string | null;
    refetchKey?: number;
};

interface Props {
    tabs: ProjectDocumentTab[];
    documents: Document[];
    activeTabId: string | null;
    quotes?: CitationQuote[];
    highlightEdit?:
        | (NonNullable<ComponentProps<typeof DocxView>["highlightEdit"]> & {
              documentId: string;
          })
        | null;
    onWarningDismiss: (documentId: string) => void;
}

/** Retain loaded bytes and viewer state for exactly the lifetime of an open tab. */
export const ProjectDocumentPanels = memo(function ProjectDocumentPanels({
    tabs,
    documents,
    activeTabId,
    quotes,
    highlightEdit,
    onWarningDismiss,
}: Props) {
    const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
    return (
        <div className="relative flex-1 min-h-0 overflow-hidden">
            {tabs.map((tab) => {
                const active = tab.documentId === activeTabId;
                const document = documentsById.get(tab.documentId);
                const versionId = tab.versionId ?? document?.current_version_id;
                // Explicit historical versions stay pinned when the current version changes.
                // Hashes detect in-place writes without refetching on rename. Legacy
                // rows without hashes use updated_at, so metadata changes can refetch.
                const refetchKey = tab.versionId
                    ? JSON.stringify([
                          tab.refetchKey ?? 0,
                          tab.versionId === document?.current_version_id
                              ? document?.content_sha256
                              : undefined,
                      ])
                    : JSON.stringify([
                          tab.refetchKey ?? 0,
                          document?.content_sha256 ?? document?.updated_at,
                          document?.status,
                          document?.pdf_storage_path,
                      ]);
                const viewType = resolveDocumentViewType({
                    filename: tab.filename,
                    fileType: tab.fileType ?? document?.file_type,
                });
                return (
                    <div
                        key={tab.documentId}
                        role="tabpanel"
                        id={`project-document-panel-${tab.documentId}`}
                        aria-labelledby={`project-document-tab-${tab.documentId}`}
                        aria-hidden={!active}
                        inert={!active}
                        // Visibility preserves layout dimensions and scroll offsets. display:none
                        // would make PDF/workbook viewers measure a zero-width canvas.
                        className={cn(
                            "absolute inset-0 flex flex-col overflow-hidden",
                            !active && "invisible pointer-events-none",
                        )}
                    >
                        {viewType === "docx" ? (
                            <DocxView
                                documentId={tab.documentId}
                                versionId={versionId}
                                cacheBytes={false}
                                refetchKey={refetchKey}
                                quotes={active ? quotes : undefined}
                                highlightEdit={
                                    active &&
                                    highlightEdit?.documentId === tab.documentId
                                        ? highlightEdit
                                        : null
                                }
                                warning={tab.warning ?? null}
                                onWarningDismiss={() =>
                                    onWarningDismiss(tab.documentId)
                                }
                                rounded={false}
                            />
                        ) : viewType === "spreadsheet" ? (
                            <SpreadsheetView
                                active={active}
                                documentId={tab.documentId}
                                versionId={versionId}
                                refetchKey={refetchKey}
                                rounded={false}
                            />
                        ) : (
                            <PdfView
                                doc={{
                                    document_id: tab.documentId,
                                    version_id: versionId,
                                }}
                                refetchKey={refetchKey}
                                quotes={active ? quotes : undefined}
                                rounded={false}
                            />
                        )}
                    </div>
                );
            })}
            {tabs.length === 0 && (
                <div className="flex h-full items-center justify-center px-8">
                    <ProjectWorkspaceTips />
                </div>
            )}
        </div>
    );
});
