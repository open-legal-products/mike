"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Upload, Loader2, X } from "lucide-react";
import {
    uploadStandaloneDocument,
    uploadProjectDocument,
    addDocumentToProject,
    getProject,
} from "@/app/lib/mikeApi";
import type { Document, Folder } from "../shared/types";
import { FileDirectory } from "../shared/FileDirectory";
import type { DirectoryTab } from "../shared/useDirectoryData";
import { Modal } from "./Modal";
import {
    SUPPORTED_DOCUMENT_ACCEPT,
    combineUploadWarnings,
    formatFailedUploadWarning,
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import {
    DOCUMENT_UPLOAD_CONCURRENCY,
    settleWithConcurrency,
} from "@/app/lib/documentDirectoryUpload";

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: Document[], projectId?: string) => void;
    breadcrumb: string[];
    initialTab?: DirectoryTab;
    projectId?: string;
    initialSelectedDocuments?: Document[];
    /** Documents uploaded outside the modal while it is mounted. */
    externalUploadedDocuments?: Document[];
    /** Keep the modal mounted (hidden) while closed so the loaded
     * directory listing survives close/reopen cycles. */
    keepMounted?: boolean;
    /** Limit the directory to the target project's files and folder tree. */
    projectDocumentsOnly?: boolean;
    tabs?: readonly DirectoryTab[];
    disabledDocumentIds?: ReadonlySet<string>;
}

const DIRECTORY_PAGE_SIZE = 40;

export function AddDocumentsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    initialTab = "files",
    projectId,
    initialSelectedDocuments,
    externalUploadedDocuments,
    keepMounted = false,
    projectDocumentsOnly = false,
    tabs,
    disabledDocumentIds,
}: Props) {
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [extraUploadedDocs, setExtraUploadedDocs] = useState<Document[]>([]);
    const [projectDocuments, setProjectDocuments] = useState<Document[]>([]);
    const [projectFolders, setProjectFolders] = useState<Folder[]>([]);
    const [projectDirectoryLoading, setProjectDirectoryLoading] =
        useState(false);
    const [projectDocumentLimitByLevel, setProjectDocumentLimitByLevel] =
        useState<Record<string, number>>({ root: DIRECTORY_PAGE_SIZE });
    const [loadedProjectFolderIds, setLoadedProjectFolderIds] = useState<
        Set<string>
    >(new Set());
    // Tracks whether the modal has ever been opened, so keepMounted only
    // keeps it (and its directory fetch) alive after first use rather than
    // eagerly loading on page mount.
    const [hasOpened, setHasOpened] = useState(open);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (open) setHasOpened(true);
    }, [open]);

    useEffect(() => {
        if (!open || !projectDocumentsOnly || !projectId) return;
        let cancelled = false;
        setProjectDirectoryLoading(true);
        getProject(projectId)
            .then((project) => {
                if (cancelled) return;
                setProjectDocuments(
                    (project.documents ?? []).filter(
                        (document) => document.status === "ready",
                    ),
                );
                setProjectFolders(project.folders ?? []);
                setProjectDocumentLimitByLevel({ root: DIRECTORY_PAGE_SIZE });
                setLoadedProjectFolderIds(new Set());
            })
            .catch(() => {
                if (cancelled) return;
                setProjectDocuments([]);
                setProjectFolders([]);
            })
            .finally(() => {
                if (!cancelled) setProjectDirectoryLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, projectDocumentsOnly, projectId]);

    // Key the sync on the id list itself so a reopen targeting different
    // documents (or ids arriving late) always re-seeds the selection.
    const initialSelectionKey = (initialSelectedDocuments ?? [])
        .map((document) => document.id)
        .join("|");
    useEffect(() => {
        if (!open) {
            wasOpenRef.current = false;
            return;
        }
        setSelectedDocuments((prev) => {
            if (!wasOpenRef.current) return initialSelectedDocuments ?? [];
            const next = new Map(prev.map((document) => [document.id, document]));
            for (const document of initialSelectedDocuments ?? []) {
                next.set(document.id, document);
            }
            return [...next.values()];
        });
        setUploadingFilenames([]);
        setUploadWarning(null);
        if (!keepMounted) {
            // When kept mounted there is no refetch on reopen, so the
            // listing (including this session's uploads) must survive.
            setExtraUploadedDocs([]);
        }
        wasOpenRef.current = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialSelectionKey]);

    const externalUploadKey = (externalUploadedDocuments ?? [])
        .map((document) => document.id)
        .join("|");
    useEffect(() => {
        if (!externalUploadedDocuments?.length) return;
        setExtraUploadedDocs((prev) => {
            const next = new Map(prev.map((document) => [document.id, document]));
            for (const document of externalUploadedDocuments) {
                next.set(document.id, document);
            }
            return [...next.values()];
        });
        if (open) {
            setSelectedDocuments((prev) => {
                const next = new Map(
                    prev.map((document) => [document.id, document]),
                );
                for (const document of externalUploadedDocuments) {
                    next.set(document.id, document);
                }
                return [...next.values()];
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalUploadKey]);

    if (!open && (!keepMounted || !hasOpened)) return null;

    async function handleConfirm() {
        if (projectId) {
            const toAssign = selectedDocuments.filter(
                (d) => d.project_id !== projectId,
            );
            const alreadyHere = selectedDocuments.filter(
                (d) => d.project_id === projectId,
            );
            if (toAssign.length > 0) {
                setUploading(true);
                try {
                    const assigned = await Promise.all(
                        toAssign.map((d) =>
                            addDocumentToProject(projectId, d.id),
                        ),
                    );
                    onSelect([...alreadyHere, ...assigned], projectId);
                } catch (err) {
                    console.error("Failed to assign documents:", err);
                } finally {
                    setUploading(false);
                }
            } else {
                onSelect(alreadyHere, projectId);
            }
            onClose();
            return;
        }

        const projectIds = new Set(
            selectedDocuments.map((d) => d.project_id).filter(Boolean),
        );
        const singleProjectId =
            projectIds.size === 1 ? [...projectIds][0]! : undefined;
        onSelect(selectedDocuments, singleProjectId);
        onClose();
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        const unsupportedWarning = formatUnsupportedDocumentWarning(unsupported);
        setUploadWarning(unsupportedWarning);
        if (supported.length === 0) {
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        setUploadingFilenames(supported.map((file) => file.name));
        setUploading(true);
        try {
            // Bounded concurrency instead of Promise.all: a 20-file drop must
            // not open 20 simultaneous multipart requests (Open-Legal-Products/mike#8),
            // and one failed file must not discard the other 19 results.
            const results = await settleWithConcurrency(
                supported,
                DOCUMENT_UPLOAD_CONCURRENCY,
                (f) =>
                    projectId
                        ? uploadProjectDocument(projectId, f)
                        : uploadStandaloneDocument(f),
            );
            const uploaded = results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : [],
            );
            const failed = supported.filter(
                (_, index) => results[index].status === "rejected",
            );
            if (failed.length > 0) console.error("Upload failed:", results);
            setUploadWarning(
                combineUploadWarnings(
                    unsupportedWarning,
                    formatFailedUploadWarning(failed),
                ),
            );
            setExtraUploadedDocs((prev) => [...uploaded, ...prev]);
            setSelectedDocuments((prev) => [
                ...prev,
                ...uploaded.filter(
                    (document) =>
                        !prev.some((selected) => selected.id === document.id),
                ),
            ]);
        } finally {
            setUploading(false);
            setUploadingFilenames([]);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const directoryDocuments = projectDocumentsOnly
        ? [
              ...extraUploadedDocs,
              ...projectDocuments.filter(
                  (document) =>
                      !extraUploadedDocs.some(
                          (uploaded) => uploaded.id === document.id,
                      ),
              ),
          ]
        : extraUploadedDocs;
    const projectDocumentCountsByLevel: Record<string, number> = {};
    directoryDocuments.forEach((document) => {
        const key = document.folder_id ?? "root";
        projectDocumentCountsByLevel[key] =
            (projectDocumentCountsByLevel[key] ?? 0) + 1;
    });
    const projectDocumentsHasMoreByFolder = Object.fromEntries(
        [...loadedProjectFolderIds].map((folderId) => [
            folderId,
            (projectDocumentCountsByLevel[folderId] ?? 0) >
                (projectDocumentLimitByLevel[folderId] ?? DIRECTORY_PAGE_SIZE),
        ]),
    );

    function handleExpandProjectFolder(folderId: string) {
        setLoadedProjectFolderIds((current) => new Set(current).add(folderId));
        setProjectDocumentLimitByLevel((current) =>
            current[folderId] != null
                ? current
                : { ...current, [folderId]: DIRECTORY_PAGE_SIZE },
        );
    }

    function handleLoadMoreProjectLevel(parentId: string | null) {
        const key = parentId ?? "root";
        setProjectDocumentLimitByLevel((current) => ({
            ...current,
            [key]:
                (current[key] ?? DIRECTORY_PAGE_SIZE) + DIRECTORY_PAGE_SIZE,
        }));
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            keepMounted={keepMounted}
            breadcrumbs={breadcrumb}
            secondaryAction={{
                label: uploading ? "Uploading…" : "Upload",
                icon: uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <Upload className="h-3.5 w-3.5" />
                ),
                onClick: () => fileInputRef.current?.click(),
                disabled: uploading,
            }}
            primaryAction={{
                label: uploading ? "Saving…" : "Confirm",
                onClick: handleConfirm,
                disabled: selectedDocuments.length === 0 || uploading,
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={handleUpload}
            />

            {uploadWarning && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                    <span className="min-w-0 flex-1">{uploadWarning}</span>
                    <button
                        type="button"
                        onClick={() => setUploadWarning(null)}
                        className="shrink-0 rounded p-0.5 text-black hover:bg-gray-100"
                        aria-label="Dismiss warning"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col">
                <FileDirectory
                    documents={directoryDocuments}
                    folders={projectDocumentsOnly ? projectFolders : undefined}
                    loading={projectDirectoryLoading}
                    selectedDocuments={selectedDocuments}
                    onChange={setSelectedDocuments}
                    uploadingFilenames={uploadingFilenames}
                    showTabs={!projectDocumentsOnly}
                    initialTab={initialTab}
                    tabs={tabs}
                    excludeProjectId={projectDocumentsOnly ? undefined : projectId}
                    disabledDocumentIds={disabledDocumentIds}
                    onExpandFolder={
                        projectDocumentsOnly
                            ? handleExpandProjectFolder
                            : undefined
                    }
                    loadedFolderIds={loadedProjectFolderIds}
                    documentLimitByLevel={projectDocumentLimitByLevel}
                    documentsHasMoreByFolder={
                        projectDocumentsHasMoreByFolder
                    }
                    onLoadMoreFolderDocuments={(folderId) =>
                        handleLoadMoreProjectLevel(folderId)
                    }
                    rootDocumentsHasMore={
                        projectDocumentsOnly &&
                        (projectDocumentCountsByLevel.root ?? 0) >
                            (projectDocumentLimitByLevel.root ??
                                DIRECTORY_PAGE_SIZE)
                    }
                    onLoadMoreRootDocuments={() =>
                        handleLoadMoreProjectLevel(null)
                    }
                />
            </div>
        </Modal>
    );
}
