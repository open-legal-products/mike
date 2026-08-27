export const MULTI_DOCUMENT_DRAG_TYPE = "application/mike-docs";
export const SINGLE_DOCUMENT_DRAG_TYPE = "application/mike-doc";

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

export function selectedDocumentRange(
    visibleDocumentIds: readonly string[],
    anchorId: string | null,
    targetId: string,
): string[] {
    const anchorIndex = anchorId ? visibleDocumentIds.indexOf(anchorId) : -1;
    const targetIndex = visibleDocumentIds.indexOf(targetId);
    if (anchorIndex < 0 || targetIndex < 0) return [targetId];
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return visibleDocumentIds.slice(start, end + 1);
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
