import { afterEach, expect, it, vi } from "vitest";
import { setRowDragPreview } from "./rowDragPreview";

afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
});

it("captures a hovered explorer row in a rounded surface without changing the source", () => {
    vi.useFakeTimers();
    const row = document.createElement("li");
    row.className = "theme-dropdown-selected";
    row.style.backgroundColor = "rgb(239, 240, 243)";
    row.textContent = "Master Services Agreement V1";
    row.setAttribute("draggable", "true");
    row.getBoundingClientRect = () =>
        ({ left: 10, top: 20, width: 300, height: 30 }) as DOMRect;
    document.body.appendChild(row);
    const setDragImage = vi.fn();
    setRowDragPreview({
        dataTransfer: { setDragImage },
        row,
        clientX: 15,
        clientY: 25,
    });
    const [preview, offsetX, offsetY] = setDragImage.mock.calls[0] as [
        HTMLElement,
        number,
        number,
    ];
    expect(preview).toHaveClass("liquid-glass-float");
    expect(preview.style.overflow).toBe("hidden");
    expect(preview.style.clipPath).toBe("inset(0 round var(--radius))");
    expect(preview.style.borderRadius).toBe("var(--radius)");
    expect(preview.style.borderWidth).toBe("0px");
    expect(preview.style.boxShadow).toBe("none");
    const clone = preview.firstElementChild as HTMLElement;
    expect(clone.style.backgroundColor).toBe("transparent");
    expect(clone.style.boxShadow).toBe("none");
    expect(clone.style.transition).toBe("none");
    expect(clone.hasAttribute("draggable")).toBe(false);
    expect(row.style.backgroundColor).toBe("rgb(239, 240, 243)");
    expect(offsetX).toBe(5);
    expect(offsetY).toBe(5);
    vi.runAllTimers();
    expect(preview.isConnected).toBe(false);
});

it("keeps the pointer anchor inside the preview bounds", () => {
    vi.useFakeTimers();
    const setDragImage = vi.fn();
    const row = document.createElement("div");
    row.getBoundingClientRect = () =>
        ({ left: 10, top: 20, width: 300, height: 30 }) as DOMRect;
    setRowDragPreview({
        dataTransfer: { setDragImage },
        row,
        clientX: 400,
        clientY: 100,
    });
    expect(setDragImage).toHaveBeenCalledWith(expect.any(HTMLElement), 300, 30);
});
