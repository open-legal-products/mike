export const MULTI_DOCUMENT_DRAG_TYPE = "application/mike-docs";
export const SINGLE_DOCUMENT_DRAG_TYPE = "application/mike-doc";

type FolderNode = {
    id: string;
    parent_folder_id: string | null;
};

export function folderTreeIds(
    folders: readonly FolderNode[],
    rootIds: Iterable<string>,
): Set<string> {
    const childrenByParentId = new Map<string, string[]>();
    for (const folder of folders) {
        if (!folder.parent_folder_id) continue;
        const children = childrenByParentId.get(folder.parent_folder_id) ?? [];
        children.push(folder.id);
        childrenByParentId.set(folder.parent_folder_id, children);
    }

    const result = new Set<string>();
    const pending = [...rootIds];
    while (pending.length > 0) {
        const folderId = pending.pop();
        if (!folderId || result.has(folderId)) continue;
        result.add(folderId);
        pending.push(...(childrenByParentId.get(folderId) ?? []));
    }
    return result;
}

export function folderSelectionRootIds(
    folders: readonly FolderNode[],
    selectedIds: ReadonlySet<string>,
): string[] {
    const parentById = new Map(
        folders.map((folder) => [folder.id, folder.parent_folder_id]),
    );
    return [...selectedIds].filter((folderId) => {
        const visited = new Set<string>([folderId]);
        let parentId = parentById.get(folderId) ?? null;
        while (parentId && !visited.has(parentId)) {
            if (selectedIds.has(parentId)) return false;
            visited.add(parentId);
            parentId = parentById.get(parentId) ?? null;
        }
        return true;
    });
}

export function collectionSelectAllState(
    visibleDocumentIds: readonly string[],
    visibleFolderIds: readonly string[],
    selectedDocumentIds: readonly string[],
    selectedFolderIds: ReadonlySet<string>,
): { allSelected: boolean; someSelected: boolean } {
    const selectedDocumentIdSet = new Set(selectedDocumentIds);
    const hasVisibleRows =
        visibleDocumentIds.length > 0 || visibleFolderIds.length > 0;
    const allSelected =
        hasVisibleRows &&
        visibleDocumentIds.every((id) => selectedDocumentIdSet.has(id)) &&
        visibleFolderIds.every((id) => selectedFolderIds.has(id));
    const someSelected =
        !allSelected &&
        (visibleDocumentIds.some((id) => selectedDocumentIdSet.has(id)) ||
            visibleFolderIds.some((id) => selectedFolderIds.has(id)));

    return { allSelected, someSelected };
}

export function writeDocumentDragPayload(
    dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
    draggedDocumentId: string,
    selectedDocumentIds: readonly string[],
): string[] {
    const ids = selectedDocumentIds.includes(draggedDocumentId)
        ? [...selectedDocumentIds]
        : [draggedDocumentId];
    dataTransfer.setData(MULTI_DOCUMENT_DRAG_TYPE, JSON.stringify(ids));
    if (ids.length === 1) {
        dataTransfer.setData(SINGLE_DOCUMENT_DRAG_TYPE, ids[0]);
    }
    dataTransfer.effectAllowed = "copyMove";
    return ids;
}

export function readDocumentDragPayload(
    dataTransfer: Pick<DataTransfer, "getData">,
): string[] {
    const encoded = dataTransfer.getData(MULTI_DOCUMENT_DRAG_TYPE);
    if (encoded) {
        try {
            const parsed = JSON.parse(encoded) as unknown;
            if (Array.isArray(parsed)) {
                return Array.from(
                    new Set(
                        parsed.filter(
                            (id): id is string =>
                                typeof id === "string" && id.length > 0,
                        ),
                    ),
                );
            }
        } catch {
            // Fall through to the legacy single-document payload.
        }
    }
    const single = dataTransfer.getData(SINGLE_DOCUMENT_DRAG_TYPE);
    return single ? [single] : [];
}

/**
 * The rows' `data-collection-row-key`s in on-screen order. Each row's top is
 * measured once before sorting: measuring inside the comparator forced about
 * 2·n·log n layout reads per shift-click. `rows` arrive in document order
 * (querySelectorAll), which breaks ties between rows on the same line.
 */
export function collectionRowKeysInVisualOrder(
    rows: readonly HTMLElement[],
): string[] {
    return rows
        .map((row, index) => ({
            key: row.dataset.collectionRowKey,
            top: row.getBoundingClientRect().top,
            index,
        }))
        .sort((left, right) => left.top - right.top || left.index - right.index)
        .map((row) => row.key)
        .filter((key): key is string => !!key);
}

/**
 * The given folders and every folder above them. Each step is a Map lookup,
 * and a folder already collected stops the walk, so shared ancestors are
 * visited once and a corrupt parent cycle cannot loop forever.
 */
export function folderAncestorIds(
    startIds: Iterable<string | null | undefined>,
    folderById: ReadonlyMap<string, FolderNode>,
): Set<string> {
    const result = new Set<string>();
    for (const startId of startIds) {
        let currentId = startId ?? null;
        while (currentId && !result.has(currentId)) {
            result.add(currentId);
            currentId = folderById.get(currentId)?.parent_folder_id ?? null;
        }
    }
    return result;
}
