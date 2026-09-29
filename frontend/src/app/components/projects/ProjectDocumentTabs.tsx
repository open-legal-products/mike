"use client";

import Image from "next/image";
import { DocumentTabBar } from "@/app/components/shared/DocumentTabBar";
import type { Document, PanelDocument } from "@/app/components/shared/types";
import type { TabDropPosition } from "@/app/lib/reorderTabs";

interface Props {
    tabs: ReadonlyArray<{
        documentId: string;
        filename: string;
        sourceDocument?: PanelDocument;
    }>;
    documents: ReadonlyArray<Document>;
    activeTabId: string | null;
    onActivate: (documentId: string) => void;
    onAddToChat?: (document: Document) => void;
    onDownloadDoc?: (document: Document) => Promise<void>;
    onRenameDoc?: (documentId: string, filename: string) => Promise<void>;
    onDeleteDoc?: (documentId: string) => Promise<void>;
    addToChatDisabled?: boolean;
    downloading?: boolean;
    onClose: (documentId: string) => void;
    onReorder: (
        draggedId: string,
        targetId: string,
        position: TabDropPosition,
    ) => void;
}

export function ProjectDocumentTabs({
    tabs,
    documents,
    activeTabId,
    onActivate,
    onAddToChat,
    onDownloadDoc,
    onRenameDoc,
    onDeleteDoc,
    addToChatDisabled,
    downloading,
    onClose,
    onReorder,
}: Props) {
    return (
        <DocumentTabBar
            label="Project documents"
            idPrefix="project-document"
            className="project-document-tabs"
            tabs={tabs.map((tab) => {
                const document = documents.find(
                    (document) => document.id === tab.documentId,
                );
                const sourceType = tab.sourceDocument?.type;
                const legalSource =
                    sourceType === "case" || sourceType === "legislation";
                return {
                    icon: legalSource ? (
                        <Image
                            src={
                                sourceType === "case"
                                    ? "/icons/legal-sources/case-law.svg"
                                    : "/icons/legal-sources/legislation.svg"
                            }
                            alt=""
                            aria-hidden="true"
                            width={14}
                            height={14}
                            className="h-3.5 w-3.5 shrink-0 object-contain"
                        />
                    ) : undefined,
                    id: tab.documentId,
                    title: tab.filename,
                    versionNumber:
                        tab.sourceDocument?.version_number ??
                        document?.active_version_number ??
                        document?.latest_version_number,
                    actions: {
                        onAddToChat:
                            document && onAddToChat
                                ? () => onAddToChat(document)
                                : undefined,
                        onDownload:
                            document && onDownloadDoc
                                ? () => onDownloadDoc(document)
                                : undefined,
                        onRename:
                            !legalSource && onRenameDoc
                                ? (name: string) =>
                                      onRenameDoc(tab.documentId, name)
                                : undefined,
                        onDelete:
                            !legalSource && onDeleteDoc
                                ? () => onDeleteDoc(tab.documentId)
                                : undefined,
                        addToChatDisabled,
                        downloading,
                    },
                };
            })}
            activeTabId={activeTabId}
            onActivate={onActivate}
            onClose={onClose}
            onReorder={onReorder}
        />
    );
}
