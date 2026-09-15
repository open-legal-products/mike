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
        rows.findIndex((row) => row.dataset.documentId === draggedDocumentId),
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
        borderRadius: "var(--radius)",
        clipPath: "inset(0 round var(--radius))",
    });

    for (const row of rows) {
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute("draggable");
        clone.style.width = `${previewWidth}px`;
        clone.style.minWidth = `${previewWidth}px`;
        clone.style.backgroundColor = "transparent";
        clone.style.transition = "none";
        // Sticky name cells also carry the selected/hover fill. Keep all row
        // surfaces transparent so the rounded preview supplies one background.
        clone
            .querySelectorAll<HTMLElement>(
                ".table-sticky-cell, .liquid-glass-selected, .liquid-glass-group-hover",
            )
            .forEach((cell) => {
                cell.style.backgroundColor = "transparent";
                cell.style.transition = "none";
            });
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
        Math.max(0, draggedRowIndex * rowHeight + clientY - draggedRect.top),
    );
    dataTransfer.setDragImage(preview, offsetX, offsetY);
    window.setTimeout(() => preview.remove(), 0);
}
