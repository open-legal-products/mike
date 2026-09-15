import { afterEach, describe, expect, it, vi } from "vitest";
import { setDocumentRowsDragPreview } from "./docTableDragPreview";

function documentRow(id: string, top: number) {
    const row = document.createElement("div");
    row.dataset.documentRow = "";
    row.dataset.documentId = id;
    row.textContent = id;
    row.style.backgroundColor = "rgb(255, 255, 255)";
    row.getBoundingClientRect = () =>
        ({
            left: 20,
            top,
            width: 420,
            height: 40,
        }) as DOMRect;
    return row;
}

describe("DocTable drag preview", () => {
    afterEach(() => {
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    it("uses every selected row in visible order and anchors the grabbed row", () => {
        vi.useFakeTimers();
        const root = document.createElement("div");
        root.append(
            documentRow("a", 100),
            documentRow("b", 140),
            documentRow("c", 180),
        );
        document.body.appendChild(root);
        const setDragImage = vi.fn();

        setDocumentRowsDragPreview({
            dataTransfer: { setDragImage },
            tableRoot: root,
            draggedDocumentIds: ["a", "b", "c"],
            draggedDocumentId: "b",
            clientX: 65,
            clientY: 155,
        });

        expect(setDragImage).toHaveBeenCalledOnce();
        const [preview, offsetX, offsetY] = setDragImage.mock.calls[0] as [
            HTMLElement,
            number,
            number,
        ];
        expect(Array.from(preview.children, (row) => row.textContent)).toEqual([
            "a",
            "b",
            "c",
        ]);
        expect(offsetX).toBe(45);
        expect(offsetY).toBe(55);

        vi.runAllTimers();
        expect(preview.isConnected).toBe(false);
    });

    it("uses a rounded preview without the inner hover fill for a single dragged row", () => {
        vi.useFakeTimers();
        const root = document.createElement("div");
        const row = documentRow("a", 100);
        const cell = document.createElement("div");
        cell.className = "table-sticky-cell liquid-glass-group-hover";
        cell.style.backgroundColor = "rgb(245, 246, 248)";
        row.appendChild(cell);
        root.appendChild(row);
        const setDragImage = vi.fn();

        setDocumentRowsDragPreview({
            dataTransfer: { setDragImage },
            tableRoot: root,
            draggedDocumentIds: ["a"],
            draggedDocumentId: "a",
            clientX: 30,
            clientY: 110,
        });

        const [preview] = setDragImage.mock.calls[0] as [HTMLElement];
        expect(preview).toHaveClass("liquid-glass-float");
        expect(preview.style.borderRadius).toBe("var(--radius)");
        expect(preview.style.clipPath).toBe("inset(0 round var(--radius))");
        expect(
            (preview.firstElementChild as HTMLElement).style.backgroundColor,
        ).toBe("transparent");
        expect(
            preview.querySelector<HTMLElement>(".table-sticky-cell")?.style
                .backgroundColor,
        ).toBe("transparent");
        expect(cell.style.backgroundColor).toBe("rgb(245, 246, 248)");
        vi.runAllTimers();
        expect(preview.isConnected).toBe(false);
    });

    it("previews only visible rows when part of the selection is offscreen", () => {
        vi.useFakeTimers();
        const root = document.createElement("div");
        root.appendChild(documentRow("a", 100));
        const setDragImage = vi.fn();

        setDocumentRowsDragPreview({
            dataTransfer: { setDragImage },
            tableRoot: root,
            draggedDocumentIds: ["a", "offscreen"],
            draggedDocumentId: "a",
            clientX: 30,
            clientY: 110,
        });

        expect(setDragImage).toHaveBeenCalledOnce();
        const [preview] = setDragImage.mock.calls[0] as [HTMLElement];
        expect(preview.children).toHaveLength(1);
        vi.runAllTimers();
    });
});
