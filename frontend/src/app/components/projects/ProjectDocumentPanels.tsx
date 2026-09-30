"use client";

import { useDocumentPermissions } from "@/app/hooks/useDocumentPermissions";

import type { DocxCloseGuard } from "../shared/views/DocxRenderer.types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { memo, useMemo } from "react";
import {
    DocumentContent,
    type DocumentContentMode,
} from "@/app/components/shared/DocumentContent";
import { ProjectWorkspaceTips } from "./ProjectWorkspaceTips";
import {
    panelDocumentFromCitation,
    type Citation,
    type Document,
    type EditAnnotation,
    type PanelDocument,
} from "@/app/components/shared/types";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import { cn } from "@/app/lib/utils";

type EditMode = Extract<DocumentContentMode, { kind: "edit" }>;
export type ProjectDocumentAnnotation =
    | { kind: "citation"; citation: Citation }
    | { kind: "edit"; edit: EditAnnotation; changeNumber?: number };

export type ProjectDocumentTab = {
    documentId: string;
    filename: string;
    fileType?: string | null;
    versionId?: string | null;
    warning?: string | null;
    refetchKey?: number;
    sourceDocument?: PanelDocument;
    annotation?: ProjectDocumentAnnotation;
};

interface Props {
    tabs: ProjectDocumentTab[];
    documents: Document[];
    activeTabId: string | null;
    isDocumentReloading?: (documentId: string) => boolean;
    isEditReloading?: (editId: string) => boolean;
    onEditResolveStart?: EditMode["onResolveStart"];
    onEditResolved?: EditMode["onResolved"];
    onEditError?: EditMode["onError"];
    onVersionChange?: (documentId: string, version: DocumentVersion) => void;
    /** Whether the viewer may edit the project's documents. */
    canEdit?: boolean;
    onCloseAnnotation?: (documentId: string) => void;
    onWarningDismiss: (documentId: string) => void;
    onCloseGuardReady?: (documentId: string, guard: DocxCloseGuard | null) => void;
    onDownloadReady?: (
        documentId: string,
        download: (() => Promise<void>) | null,
    ) => void;
}

/** Retain loaded bytes and viewer state for exactly the lifetime of an open tab. */
export const ProjectDocumentPanels = memo(function ProjectDocumentPanels({
    tabs,
    documents,
    activeTabId,
    isEditReloading,
    isDocumentReloading,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onCloseAnnotation,
    onVersionChange,
    canEdit = false,
    onWarningDismiss,
    onDownloadReady,
    onCloseGuardReady,
}: Props) {
    const panels = useMemo(() => {
        const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
        return tabs.map((tab) => {
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
            const annotation = tab.annotation;
            const citedDocument =
                annotation?.kind === "citation"
                    ? panelDocumentFromCitation(annotation.citation)
                    : undefined;
            const sourceDocument = citedDocument
                ? {
                      ...citedDocument,
                      ...tab.sourceDocument,
                      quotes: citedDocument.quotes,
                  }
                : tab.sourceDocument;
            const panelDocument: PanelDocument = {
                ...sourceDocument,
                document_id: tab.documentId,
                title: tab.filename,
                type: sourceDocument?.type ?? viewType,
                version_id: versionId,
                version_number:
                    !tab.versionId ||
                    tab.versionId === document?.current_version_id
                        ? (document?.active_version_number ??
                          document?.latest_version_number ??
                          sourceDocument?.version_number)
                        : sourceDocument?.version_number,
                metadata: sourceDocument?.metadata ?? [],
                quotes:
                    annotation?.kind === "citation"
                        ? (sourceDocument?.quotes ?? [])
                        : [],
            };
            return { tab, panelDocument, refetchKey };
        });
    }, [tabs, documents]);
    const permissions = useDocumentPermissions(tabs.map((tab) => tab.documentId), canEdit);
    return (
        <div className="relative flex-1 min-h-0 overflow-hidden">
            {panels.map(({ tab, panelDocument, refetchKey }) => {
                const active = tab.documentId === activeTabId;
                const annotation = tab.annotation;
                const mode: DocumentContentMode =
                    annotation?.kind === "edit"
                        ? {
                              ...annotation,
                              isEditReloading: isEditReloading?.(
                                  annotation.edit.edit_id,
                              ),
                              onResolveStart: onEditResolveStart,
                              onResolved: onEditResolved,
                              onError: onEditError,
                          }
                        : (annotation ?? { kind: "document" });
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
                        <DocumentContent
                            document={panelDocument}
                            mode={mode}
                            canEdit={permissions(tab.documentId).canEdit}
                            onVersionChange={
                                onVersionChange
                                    ? (version) =>
                                          onVersionChange(
                                              tab.documentId,
                                              version,
                                          )
                                    : undefined
                            }
                            active={active}
                            isReloading={
                                isDocumentReloading?.(tab.documentId) ||
                                (annotation?.kind === "edit" &&
                                    !!isEditReloading?.(
                                        annotation.edit.edit_id,
                                    ))
                            }
                            cacheBytes={false}
                            refetchKey={refetchKey}
                            warning={tab.warning ?? null}
                            onWarningDismiss={() =>
                                onWarningDismiss(tab.documentId)
                            }
                            onCloseAnnotation={
                                onCloseAnnotation
                                    ? () => onCloseAnnotation(tab.documentId)
                                    : undefined
                            }
                            onCloseGuardReady={(guard) => onCloseGuardReady?.(tab.documentId, guard)}
                            onDownloadReady={(download) =>
                                onDownloadReady?.(tab.documentId, download)
                            }
                        />
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
