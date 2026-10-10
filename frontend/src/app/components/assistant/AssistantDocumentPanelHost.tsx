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
    const { tabs, setTabs, setActiveTabId, targetPane, canWrite } = panel;

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
                    className={`fixed inset-0 z-40 flex justify-center p-3 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0 ${panel.panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        canEdit={canWrite}
                        chatCount={Math.max(1, panel.paneCount)}
                        documentActions={(document) => ({
                            addToChatDisabled:
                                !targetPane?.canWrite ||
                                !!targetPane.chatLoading,
                            onAddToChat: async () => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                targetPane?.addDocument(file);
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
            )}

            <AddDocumentsModal
                open={openDocumentsModalOpen}
                onClose={() => setOpenDocumentsModalOpen(false)}
                onSelect={(documents) => {
                    setOpenDocumentsModalOpen(false);
                    documents.forEach((document) =>
                        targetPane?.openDocument(document),
                    );
                }}
                breadcrumb={["Assistant", "Open Documents"]}
                uploadStateId="assistant-side-panel"
            />
        </>
    );
}
