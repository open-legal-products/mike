import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybookPanels } from "./PlaybookPanels";

let measure: (width: number) => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        measure = (width) =>
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPanels(variant: "sidebar" | "results" = "sidebar") {
  const resizeLabel = variant === "results" ? "Resize run results panel" : "Resize rules panel";
  const view = render(
    <PlaybookPanels variant={variant} resizeLabel={resizeLabel} sidebar={<section>Rules</section>}>
      <section>Form</section>
    </PlaybookPanels>,
  );
  act(() => measure(900));
  const divider = screen.getByRole("separator", { name: resizeLabel });
  divider.setPointerCapture = vi.fn();
  divider.releasePointerCapture = vi.fn();
  return { ...view, divider };
}

describe("playbook panels", () => {
  it("resizes the right-hand results pane in the drag direction and supports keyboard limits", () => {
    const { divider } = renderPanels("results");
    expect(divider).toHaveAttribute("aria-valuenow", "448");
    fireEvent.pointerDown(divider, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(divider, { clientX: 400, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "548");
    fireEvent.pointerMove(divider, { clientX: 900, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "320");
    fireEvent.pointerUp(divider, { pointerId: 1 });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "344");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider).toHaveAttribute("aria-valuenow", "574");
    act(() => measure(700));
    expect(divider).toHaveAttribute("aria-valuenow", "374");
  });

  it("drags the divider within both panels' minimum widths", () => {
    const { divider } = renderPanels();
    fireEvent.pointerDown(divider, { clientX: 320, pointerId: 1, button: 0 });
    fireEvent.pointerMove(divider, { clientX: 420, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "420");
    fireEvent.pointerMove(divider, { clientX: 1500, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "574");
    fireEvent.pointerMove(divider, { clientX: 0, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "160");
    fireEvent.pointerUp(divider, { pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 100, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "160");
    expect(document.body.style.cursor).toBe("");
  });

  it("supports keyboard resizing and fits the available container width", () => {
    const { divider } = renderPanels();
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "344");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider).toHaveAttribute("aria-valuenow", "574");
    act(() => measure(700));
    expect(divider).toHaveAttribute("aria-valuenow", "374");
    act(() => measure(900));
    expect(divider).toHaveAttribute("aria-valuenow", "574");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider).toHaveAttribute("aria-valuenow", "160");
  });

  it("cleans up drag styling on cancellation and unmount", () => {
    const { divider, unmount } = renderPanels();
    document.body.style.cursor = "default";
    document.body.style.userSelect = "text";
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0 });
    expect(document.body.style.cursor).toBe("col-resize");
    fireEvent.pointerCancel(divider, { pointerId: 1 });
    expect(document.body.style.cursor).toBe("default");
    fireEvent.pointerDown(divider, { pointerId: 2, button: 0 });
    unmount();
    expect(document.body.style.cursor).toBe("default");
    expect(document.body.style.userSelect).toBe("text");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
});
