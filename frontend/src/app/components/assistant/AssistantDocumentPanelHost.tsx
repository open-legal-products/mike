"use client";

import { useState } from "react";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
    deleteDocument,
    getDocument,
    renameLibraryDocument,
    renameProjectDocument,
} from "@/app/lib/mikeApi";
import { panelDocumentAtVersion } from "@/app/lib/panelDocumentAtVersion";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import type { PanelDocument } from "../shared/types";
import { AssistantSidePanel } from "./AssistantSidePanel";
import type { AssistantDocumentPanel } from "./useAssistantDocumentPanel";

/**
 * The document side panel beside the assistant's chats, with the dialogs its
 * tab actions open. Render it once per page, after the chat columns.
 */
export function AssistantDocumentPanelHost({
    panel,
}: {
    panel: AssistantDocumentPanel;
}) {
    const [deleteTarget, setDeleteTarget] = useState<PanelDocument | null>(
        null,
    );
    const [deletingDocument, setDeletingDocument] = useState(false);
    const [openDocumentsModalOpen, setOpenDocumentsModalOpen] = useState(false);
    const [actionError, setActionError] = useState<{
        title: string;
        message: string;
    } | null>(null);
    const { tabs, setTabs, setActiveTabId, getTargetPane, canWrite } = panel;

    return (
        <>
            <ConfirmPopup
                open={!!deleteTarget}
                title="Delete file?"
                message={`Delete “${deleteTarget?.title ?? "this file"}” and its versions? This cannot be undone.`}
                confirmLabel="Delete file"
                confirmVariant="danger"
                confirmStatus={deletingDocument ? "loading" : "idle"}
                onCancel={() => { if (!deletingDocument) setDeleteTarget(null); }}
                onConfirm={() => {
                    if (!deleteTarget || deletingDocument || !canWrite) return;
                    const target = deleteTarget;
                    setDeletingDocument(true);
                    void (async () => {
                        try {
                            const file = await getDocument(target.document_id);
                            if (file.can_delete !== true) {
                                setActionError({ title: "Delete failed", message: "You do not have permission to delete this file." });
                                return;
                            }
                            await deleteDocument(target.document_id);
                            setTabs((current) => {
                                const remaining = current.filter((tab) => tab.document.document_id !== target.document_id);
                                setActiveTabId((id) => remaining.some((tab) => tab.id === id) ? id : remaining[0]?.id ?? null);
                                return remaining;
                            });
                            setDeleteTarget(null);
                        } catch (cause) {
                            setActionError({ title: "Delete failed", message: userFacingApiError(cause, "This file could not be deleted. Please try again.") });
                        } finally { setDeletingDocument(false); }
                    })();
                }}
            />
            <WarningPopup
                open={!!actionError}
                title={actionError?.title ?? "Chat action failed"}
                message={actionError?.message ?? null}
                onClose={() => setActionError(null)}
            />

            {panel.panelMounted && (
                <div
                    className={cn(
                        // Small screens: an overlay that slides across.
                        // Both slides are `motion-safe`: a `motion-reduce`
                        // override loses to the `md:` transition below.
                        "fixed inset-0 z-40 p-3 motion-safe:transition-transform motion-safe:duration-300",
                        panel.panelVisible
                            ? "translate-x-0"
                            : "translate-x-full",
                        // From md the panel sits in the row beside the chats,
                        // and what slides is the room it takes there: the
                        // column grows from nothing to the panel's width
                        // (0fr to 1fr), carrying the panel in from the edge
                        // while the chats give way at the same pace. Moving
                        // the panel alone left its full width reserved from
                        // the first frame, so the chats jumped.
                        "md:relative md:inset-auto md:z-auto md:grid md:h-full md:shrink-0 md:translate-x-0 md:p-0 md:motion-safe:transition-[grid-template-columns]",
                        panel.panelVisible
                            ? "md:grid-cols-[1fr]"
                            : "md:grid-cols-[0fr]",
                    )}
                >
                    {/* The column: narrower than the panel while it slides,
                        with the panel running past it and off the page. */}
                    <div className="flex h-full w-full justify-center md:block md:w-auto md:min-w-0">
                    <AssistantSidePanel
                        tabs={tabs}
                        canEdit={canWrite}
                        chatCount={Math.max(1, panel.paneCount)}
                        documentActions={(document) => ({
                            addToChatDisabled: !panel.canAddToChat,
                            onAddToChat: async () => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                getTargetPane(true)?.addDocument(file);
                            },
                            onRename: async (filename) => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                const updated = file.project_id
                                    ? await renameProjectDocument(
                                          file.project_id,
                                          file.id,
                                          filename,
                                      )
                                    : await renameLibraryDocument(
                                          file.library_kind === "template"
                                              ? "templates"
                                              : "files",
                                          file.id,
                                          filename,
                                      );
                                setTabs((current) =>
                                    current.map((tab) =>
                                        tab.document.document_id === file.id
                                            ? {
                                                  ...tab,
                                                  document: {
                                                      ...tab.document,
                                                      title: updated.filename,
                                                  },
                                              }
                                            : tab,
                                    ),
                                );
                            },
                            onDelete: canWrite ? () => setDeleteTarget(document) : undefined,
                        })}
                        activeTabId={panel.activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={panel.closeTab}
                        onCloseAll={panel.closeAllTabs}
                        onVersionChange={(tabId, version) => setTabs((current) => current.map((tab) =>
                            tab.id === tabId ? { id: tab.id, kind: "document", document: panelDocumentAtVersion(tab.document, version) } : tab))}
                        onReorderTabs={panel.reorderTabs}
                        isEditorReloading={(documentId) =>
                            panel.reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            panel.reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={panel.handleEditResolveStart}
                        onEditResolved={panel.handleEditResolved}
                        onEditError={panel.handleEditError}
                        onWarningDismiss={panel.handleWarningDismiss}
                        onCloseAnnotation={panel.handleCloseAnnotation}
                        onScrollChange={panel.handleScrollChange}
                        onOpenDocuments={() => setOpenDocumentsModalOpen(true)}
                    />
                    </div>
                </div>
            )}

            <AddDocumentsModal
                open={openDocumentsModalOpen}
                onClose={() => setOpenDocumentsModalOpen(false)}
                onSelect={(documents) => {
                    setOpenDocumentsModalOpen(false);
                    documents.forEach((document) =>
                        getTargetPane()?.openDocument(document),
                    );
                }}
                breadcrumb={["Assistant", "Open Documents"]}
                uploadStateId="assistant-side-panel"
            />
        </>
    );
}
