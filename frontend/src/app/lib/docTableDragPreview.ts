import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

type DragPreviewOptions = {
    dataTransfer: Pick<DataTransfer, "setDragImage">;
    tableRoot: HTMLElement | null;
    draggedDocumentIds: readonly string[];
    draggedDocumentId: string;
    clientX: number;
    clientY: number;
};

/**
 * Capture only the selected rows, including single-row drags: native capture
 * can include the table's scrollbar. Remove the preview after capture.
 */
export function setDocumentRowsDragPreview({
    dataTransfer,
    tableRoot,
    draggedDocumentIds,
    draggedDocumentId,
    clientX,
    clientY,
}: DragPreviewOptions): void {
    if (!tableRoot || draggedDocumentIds.length === 0) return;

    const draggedIdSet = new Set(draggedDocumentIds);
    const rows = Array.from(
        tableRoot.querySelectorAll<HTMLElement>(
            "[data-document-row][data-document-id]",
        ),
    ).filter((row) => {
        const id = row.dataset.documentId;
        return !!id && draggedIdSet.has(id);
    });
    if (rows.length === 0) return;

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
    preview.className = LIQUID_GLASS_FLOAT_CLASS;
    Object.assign(preview.style, {
        position: "fixed",
        left: "-10000px",
        top: "-10000px",
        width: `${previewWidth}px`,
        overflow: "hidden",
        pointerEvents: "none",
        borderRadius: "0",
        border: "0",
        boxShadow: "none",
    });

    for (const row of rows) {
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute("draggable");
        clone.style.width = `${previewWidth}px`;
        clone.style.minWidth = `${previewWidth}px`;
        // One square surface, without selected/hover fills or backing shadows.
        clone.style.backgroundColor = "transparent";
        clone.style.borderRadius = "0";
        clone.style.boxShadow = "none";
        clone.style.transition = "none";
        for (const cell of clone.querySelectorAll<HTMLElement>(
            ".table-sticky-cell",
        )) {
            cell.style.backgroundColor = "transparent";
        }
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
