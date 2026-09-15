"use client";

import { isProjectItemDrag } from "@/app/lib/projectDragTypes";
import { setRowDragPreview } from "@/app/lib/rowDragPreview";
import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import {
    ChevronRight,
    ChevronDown,
    FileText,
    Download,
    Loader2,
    MessageSquarePlus,
    Pencil,
    Trash2,
} from "lucide-react";
import type {
    Document,
    Folder as ProjectFolder,
} from "@/app/components/shared/types";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
    ProjectSvgIcon,
    SubfolderSvgIcon,
} from "@/app/components/shared/FolderSvgIcon";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

interface Props {
    projectName?: string | null;
    documents: Document[];
    folders?: ProjectFolder[];
    selectedDocId?: string | null;
    onDocClick: (doc: Document) => void;
    onAddToChat?: (doc: Document) => void;
    onDownloadDoc?: (doc: Document) => Promise<void>;
    onDownloadFolder?: (folder: ProjectFolder) => Promise<void>;
    downloading?: boolean;
    addToChatDisabled?: boolean;
    onCreateFolder?: (parentFolderId: string | null, name: string) => Promise<void>;
    onRenameFolder?: (folderId: string, name: string) => Promise<void>;
    onRenameDoc?: (docId: string, filename: string) => Promise<void>;
    onDeleteFolder?: (folderId: string) => Promise<void>;
    onDeleteDoc?: (docId: string) => Promise<void>;
    onMoveDoc?: (docId: string, targetFolderId: string | null) => Promise<void>;
    onMoveFolder?: (folderId: string, targetFolderId: string | null) => Promise<void>;
    uploadingDocuments?: ReadonlyArray<{
        clientId: string;
        filename: string;
    }>;
}

export interface ProjectExplorerHandle {
    createRootFolder: () => void;
}

type ContextMenuState = {
    x: number;
    y: number;
    parentId: string | null;      // folder to create inside (null = root)
    folderId?: string;             // set if right-clicked on a specific folder
    docId?: string;                // set if right-clicked on a specific document
};

export const ProjectExplorer = forwardRef<ProjectExplorerHandle, Props>(function ProjectExplorer({
    projectName,
    documents,
    folders = [],
    selectedDocId,
    onDocClick,
    onAddToChat,
    onDownloadDoc,
    onDownloadFolder,
    downloading = false,
    addToChatDisabled = false,
    onCreateFolder,
    onRenameFolder,
    onRenameDoc,
    onDeleteFolder,
    onDeleteDoc,
    onMoveDoc,
    onMoveFolder,
    uploadingDocuments = [],
}: Props, ref) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const newFolderInputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const contextDocument = contextMenu?.docId
        ? documents.find((document) => document.id === contextMenu.docId)
        : undefined;
    const contextFolder = contextMenu?.folderId
        ? folders.find((folder) => folder.id === contextMenu.folderId)
        : undefined;

    useImperativeHandle(ref, () => ({
        createRootFolder: () => {
            setCreatingIn(null);
            setNewFolderName("");
        },
    }), []);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    // Clear all drag state when drag ends
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);

    function toggleFolder(id: string) {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    async function commitNewFolder(parentId: string | null) {
        const name = newFolderName.trim();
        // Empty name → leave the input in place. Users dismiss with Escape.
        // This guards against a React StrictMode race where the simulated
        // unmount fires a blur that would otherwise immediately collapse
        // the freshly-mounted input.
        if (!name) return;
        setCreatingIn(undefined);
        setNewFolderName("");
        if (!onCreateFolder) return;
        await onCreateFolder(parentId, name);
        if (parentId) setExpandedIds((prev) => new Set([...prev, parentId]));
    }

    async function commitRename(folderId: string) {
        const name = renameValue.trim();
        setRenamingId(null);
        if (!name || !onRenameFolder) return;
        await onRenameFolder(folderId, name);
    }

    async function commitDocRename(docId: string) {
        const filename = renameValue.trim();
        setRenamingDocId(null);
        if (!filename || !onRenameDoc) return;
        await onRenameDoc(docId, filename);
    }

    function openContextMenu(
        e: React.MouseEvent,
        parentId: string | null,
        folderId?: string,
        docId?: string,
    ) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, parentId, folderId, docId });
    }

    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        let cur: ProjectFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }

    async function handleDropOnTarget(targetFolderId: string | null, e: React.DragEvent) {
        const docId = e.dataTransfer.getData("application/mike-doc");
        const movingFolderId = e.dataTransfer.getData("application/mike-folder");

        if (docId && onMoveDoc) {
            const doc = documents.find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            await onMoveDoc(docId, targetFolderId);
        } else if (movingFolderId && movingFolderId !== targetFolderId && onMoveFolder) {
            if (targetFolderId !== null && wouldCreateCycle(movingFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === movingFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            await onMoveFolder(movingFolderId, targetFolderId);
        }
    }

    function isInternalDrag(e: React.DragEvent): boolean {
        return isProjectItemDrag(e.dataTransfer);
    }

    function renderLevel(parentId: string | null, depth: number): React.ReactNode {
        const basePadding = 8 + (depth - 1) * 16;
        const childFolders = folders
            .filter((f) => f.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = documents.filter((d) => (d.folder_id ?? null) === parentId);

        return (
            <>
                {parentId === null &&
                    uploadingDocuments.map((upload) => (
                        <li
                            key={`uploading-${upload.clientId}`}
                            role="status"
                            aria-label={`Uploading ${upload.filename}`}
                            className="flex items-center gap-2 py-1.5 pr-2 text-gray-400"
                            style={{ paddingLeft: basePadding }}
                        >
                            <FileTypeIcon
                                fileType={upload.filename}
                                className="h-3.5 w-3.5"
                                muted
                            />
                            <span className="min-w-0 flex-1 truncate text-xs">
                                {upload.filename}
                            </span>
                            <Loader2
                                aria-hidden="true"
                                className="h-3 w-3 shrink-0 animate-spin"
                            />
                        </li>
                    ))}

                {/* Inline new-folder input */}
                {creatingIn === parentId && (
                    <li
                        className="flex items-center gap-1.5 py-1.5 pr-2 select-none"
                        style={{ paddingLeft: basePadding }}
                    >
                        <ChevronRight className="h-3 w-3 text-gray-300 shrink-0" />
                        <SubfolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                        <input
                            ref={newFolderInputRef}
                            autoFocus
                            className="flex-1 min-w-0 text-xs bg-transparent outline-none border-b border-gray-300 text-gray-800"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void commitNewFolder(parentId);
                                if (e.key === "Escape") { setCreatingIn(undefined); setNewFolderName(""); }
                            }}
                            onBlur={() => void commitNewFolder(parentId)}
                        />
                    </li>
                )}

                {/* Child folders */}
                {childFolders.map((folder) => {
                    const isExpanded = expandedIds.has(folder.id);
                    const isRenaming = renamingId === folder.id;
                    const isDragTarget = dragOverFolderId === folder.id;
                    return (
                        <li key={`f-${folder.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData("application/mike-folder", folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    setRowDragPreview({
                                        dataTransfer: e.dataTransfer,
                                        row: e.currentTarget,
                                        clientX: e.clientX,
                                        clientY: e.clientY,
                                    });
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    if (!isInternalDrag(e)) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                    setDragOverRoot(false);
                                }}
                                onDragLeave={(e) => {
                                    if (!isInternalDrag(e)) return;
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    if (isInternalDrag(e)) {
                                        e.stopPropagation();
                                        setDragOverFolderId(null);
                                        setDragOverRoot(false);
                                        await handleDropOnTarget(folder.id, e);
                                    }
                                }}
                                className={`group flex cursor-pointer select-none items-center gap-1.5 rounded-lg py-1.5 pr-2 transition-colors ${
                                    isDragTarget
                                        ? "bg-blue-50 ring-1 ring-inset ring-blue-200"
                                        : "theme-dropdown-item"
                                }`}
                                style={{ paddingLeft: basePadding }}
                                onClick={() => toggleFolder(folder.id)}
                                onContextMenu={(e) =>
                                    openContextMenu(e, folder.id, folder.id)
                                }
                            >
                                {isExpanded
                                    ? <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
                                    : <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
                                }
                                <SubfolderSvgIcon
                                    open={isExpanded}
                                    className="h-3.5 w-3.5 shrink-0"
                                />
                                {isRenaming ? (
                                    <input
                                        autoFocus
                                        className="flex-1 min-w-0 text-xs bg-transparent outline-none border-b border-gray-300 text-gray-800"
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") void commitRename(folder.id);
                                            if (e.key === "Escape") setRenamingId(null);
                                        }}
                                        onBlur={() => void commitRename(folder.id)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    <span className="text-xs text-gray-600 truncate">{folder.name}</span>
                                )}
                            </div>
                            {isExpanded && (
                                <ul>{renderLevel(folder.id, depth + 1)}</ul>
                            )}
                        </li>
                    );
                })}

                {/* Child documents */}
                {childDocs.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    const isRenaming = renamingDocId === doc.id;
                    return (
                        <li
                            key={`d-${doc.id}`}
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.setData("application/mike-doc", doc.id);
                                e.dataTransfer.effectAllowed = "copyMove";
                                setRowDragPreview({
                                    dataTransfer: e.dataTransfer,
                                    row: e.currentTarget,
                                    clientX: e.clientX,
                                    clientY: e.clientY,
                                });
                            }}
                            onDragOver={(e) => {
                                // Internal moves do not target document rows;
                                // external files bubble to the panel upload target.
                                if (isInternalDrag(e)) e.stopPropagation();
                            }}
                            onClick={() => onDocClick(doc)}
                            onContextMenu={(e) =>
                                openContextMenu(
                                    e,
                                    doc.folder_id ?? null,
                                    undefined,
                                    doc.id,
                                )
                            }
                            className={`flex cursor-pointer select-none items-center gap-2 rounded-lg py-1.5 pr-4 transition-colors ${
                                isSelected ? "theme-dropdown-selected text-gray-900" : "theme-dropdown-item text-gray-600 hover:text-gray-900"
                            }`}
                            style={{ paddingLeft: basePadding }}
                        >
                            <FileTypeIcon fileType={doc.file_type} />
                            {isRenaming ? (
                                <input
                                    autoFocus
                                    className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-xs text-gray-800 outline-none"
                                    value={renameValue}
                                    onChange={(event) =>
                                        setRenameValue(event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                            void commitDocRename(doc.id);
                                        if (event.key === "Escape")
                                            setRenamingDocId(null);
                                    }}
                                    onBlur={() => void commitDocRename(doc.id)}
                                    onClick={(event) => event.stopPropagation()}
                                />
                            ) : (
                                <span className="truncate text-xs">
                                    {doc.filename}
                                </span>
                            )}
                            <VersionChip
                                n={
                                    doc.active_version_number ??
                                    doc.latest_version_number
                                }
                            />
                        </li>
                    );
                })}
            </>
        );
    }

    return (
        <ul
            className={`relative h-full rounded-bl-2xl rounded-br-lg p-1 ${dragOverRoot && dragOverFolderId === null ? "ring-2 ring-blue-400 ring-inset" : ""}`}
            onContextMenu={(e) => {
                // Only fires if not stopped by a child
                openContextMenu(e, null);
            }}
            onDragOver={(e) => {
                if (isInternalDrag(e)) {
                    e.preventDefault();
                    setDragOverRoot(true);
                }
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverRoot(false);
                }
            }}
            onDrop={async (e) => {
                e.preventDefault();
                if (isInternalDrag(e)) {
                    e.stopPropagation();
                    setDragOverRoot(false);
                    setDragOverFolderId(null);
                    await handleDropOnTarget(null, e);
                }
                // External file drops bubble up to the parent panel's onDrop (upload handler)
            }}
        >
            {/* Project root row */}
            {projectName && (
                <li
                    className="flex items-center gap-2 px-2 py-1.5 select-none"
                    onContextMenu={(e) => { e.stopPropagation(); openContextMenu(e, null); }}
                >
                    <ProjectSvgIcon open className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-xs font-semibold text-gray-500">{projectName}</span>
                </li>
            )}

            {/* Tree (depth 1 = direct children of root).
                Root-level new-folder input is rendered here by renderLevel
                when creatingIn === null — no separate top-level block. */}
            {renderLevel(null, 1)}

            {/* Empty state */}
            {documents.length === 0 &&
                folders.length === 0 &&
                uploadingDocuments.length === 0 &&
                creatingIn === undefined && (
                    <li className="px-4 py-2 text-xs text-gray-400">
                        No documents in this project.
                    </li>
                )}

            {/* Context menu */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className={`fixed z-50 w-44 overflow-hidden rounded-lg text-xs ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    {contextDocument && (
                        <button
                            type="button"
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                            onClick={() => {
                                onDocClick(contextDocument);
                                setContextMenu(null);
                            }}
                        >
                            <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            Open
                        </button>
                    )}
                    {contextDocument && onAddToChat && (
                        <button
                            type="button"
                            disabled={addToChatDisabled}
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => {
                                onAddToChat(contextDocument);
                                setContextMenu(null);
                            }}
                        >
                            <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            Add to chat
                        </button>
                    )}
                    {((contextDocument && onDownloadDoc) || (contextFolder && onDownloadFolder)) && (
                        <button
                            type="button"
                            disabled={downloading}
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => {
                                if (contextDocument) void onDownloadDoc?.(contextDocument);
                                else if (contextFolder) void onDownloadFolder?.(contextFolder);
                                setContextMenu(null);
                            }}
                        >
                            <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            Download
                        </button>
                    )}
                    {onCreateFolder && !contextMenu.docId && (
                        <button
                            type="button"
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                            onClick={() => {
                                setContextMenu(null);
                                if (contextMenu.parentId) {
                                    setExpandedIds((prev) =>
                                        new Set([...prev, contextMenu.parentId!]),
                                    );
                                }
                                setCreatingIn(contextMenu.parentId);
                                setNewFolderName("");
                            }}
                        >
                            <SubfolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                            New subfolder
                        </button>
                    )}
                    {contextMenu.folderId && onRenameFolder && (
                        <button
                            type="button"
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700"
                            onClick={() => {
                                setRenameValue(contextFolder?.name ?? "");
                                setRenamingId(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            Rename
                        </button>
                    )}
                    {contextMenu.docId && onRenameDoc && (
                        <button
                            type="button"
                            className="theme-dropdown-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700"
                            onClick={() => {
                                setRenameValue(contextDocument?.filename ?? "");
                                setRenamingDocId(contextMenu.docId!);
                                setContextMenu(null);
                            }}
                        >
                            <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                            Rename
                        </button>
                    )}
                    {contextMenu.folderId && onDeleteFolder && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                onDeleteFolder(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            Delete folder
                        </button>
                    )}
                    {contextMenu.docId && onDeleteDoc && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                void onDeleteDoc(contextMenu.docId!);
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            Delete file
                        </button>
                    )}
                </div>
            )}
        </ul>
    );
});
