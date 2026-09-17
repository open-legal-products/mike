import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

/** Capture an explorer row in a rounded surface without its hover/selection fill. */
export function setRowDragPreview({
    dataTransfer,
    row,
    clientX,
    clientY,
}: {
    dataTransfer: Pick<DataTransfer, "setDragImage">;
    row: HTMLElement;
    clientX: number;
    clientY: number;
}): void {
    const draggedRect = row.getBoundingClientRect();
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
        // Native drag capture can include the material's rectangular shadow.
        border: "0",
        boxShadow: "none",
    });

    const clone = row.cloneNode(true) as HTMLElement;
    clone.removeAttribute("draggable");
    clone.style.width = `${previewWidth}px`;
    clone.style.minWidth = `${previewWidth}px`;
    clone.style.backgroundColor = "transparent";
    clone.style.boxShadow = "none";
    clone.style.transition = "none";
    preview.appendChild(clone);

    document.body.appendChild(preview);
    const rowHeight = Math.max(1, draggedRect.height);
    const offsetX = Math.min(
        previewWidth,
        Math.max(0, clientX - draggedRect.left),
    );
    const offsetY = Math.min(rowHeight, Math.max(0, clientY - draggedRect.top));
    dataTransfer.setDragImage(preview, offsetX, offsetY);
    window.setTimeout(() => preview.remove(), 0);
}
