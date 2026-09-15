type DragPreviewOptions = {
    dataTransfer: Pick<DataTransfer, "setDragImage">;
    tableRoot: HTMLElement | null;
    draggedDocumentIds: readonly string[];
    draggedDocumentId: string;
    clientX: number;
    clientY: number;
};

/**
 * Replace the browser's single-row drag image with the complete visible
 * selection. The preview is removed after the drag image has been captured.
 */
export function setDocumentRowsDragPreview({
    dataTransfer,
    tableRoot,
    draggedDocumentIds,
    draggedDocumentId,
    clientX,
    clientY,
}: DragPreviewOptions): void {
    if (!tableRoot || draggedDocumentIds.length < 2) return;

    const draggedIdSet = new Set(draggedDocumentIds);
    const rows = Array.from(
        tableRoot.querySelectorAll<HTMLElement>(
            "[data-document-row][data-document-id]",
        ),
    ).filter((row) => {
        const id = row.dataset.documentId;
        return !!id && draggedIdSet.has(id);
    });
    if (rows.length < 2) return;

    const draggedRowIndex = Math.max(
        0,
        rows.findIndex(
            (row) => row.dataset.documentId === draggedDocumentId,
        ),
    );
    const draggedRow = rows[draggedRowIndex];
    const draggedRect = draggedRow.getBoundingClientRect();
    const previewWidth = Math.max(1, Math.ceil(draggedRect.width));
    const preview = document.createElement("div");
    preview.setAttribute("aria-hidden", "true");
    Object.assign(preview.style, {
        position: "fixed",
        left: "-10000px",
        top: "-10000px",
        width: `${previewWidth}px`,
        overflow: "hidden",
        pointerEvents: "none",
        borderRadius: "10px",
        boxShadow: "0 12px 30px rgba(15, 23, 42, 0.18)",
    });

    for (const row of rows) {
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute("draggable");
        clone.style.width = `${previewWidth}px`;
        clone.style.minWidth = `${previewWidth}px`;
        clone.style.backgroundColor = getComputedStyle(row).backgroundColor;
        preview.appendChild(clone);
    }

    document.body.appendChild(preview);
    const rowHeight = Math.max(1, draggedRect.height);
    const offsetX = Math.min(
        previewWidth,
        Math.max(0, clientX - draggedRect.left),
    );
    const offsetY = Math.min(
        rows.length * rowHeight,
        Math.max(
            0,
            draggedRowIndex * rowHeight + clientY - draggedRect.top,
        ),
    );
    dataTransfer.setDragImage(preview, offsetX, offsetY);
    window.setTimeout(() => preview.remove(), 0);
}
