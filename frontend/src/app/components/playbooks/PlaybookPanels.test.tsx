import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageSheet } from "@/app/components/shared/PageSheet";
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

function renderPanels(variant: "sidebar" | "trailing" = "sidebar") {
  const resizeLabel = variant === "trailing" ? "Resize document panel" : "Resize rules panel";
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
  it("sets its panes flat on a page sheet, with a line between them", () => {
    render(
      <PageSheet>
        <PlaybookPanels resizeLabel="Resize rules panel" sidebar={<section>Rules</section>}>
          <section>Form</section>
        </PlaybookPanels>
      </PageSheet>,
    );
    act(() => measure(900));
    const grid = screen.getByText("Rules").parentElement!.parentElement!;
    // Past the sheet's edges by 8px, so the panes' 20px inset puts their text
    // 12px in; to the sheet's foot; and its usual card spacing below md.
    expect(grid).toHaveClass("md:-mx-2", "md:mb-0", "md:p-0", "mx-3.5");
    // A line across the top of both panes.
    expect(grid).toHaveClass("md:border-t", "md:border-border");
    const line = screen
      .getByRole("separator", { name: "Resize rules panel" })
      .querySelector(".rounded-full");
    expect(line).toHaveClass("md:bg-border", "inset-y-0", "md:w-px");
  });

  it("lines its cards' edges up with the page title", () => {
    renderPanels();
    const grid = screen.getByText("Rules").parentElement!.parentElement!;
    // 14px + the 2px kept for the cards' shadows = the title's 16px;
    // 22px + 2px = 24px from md up.
    expect(grid).toHaveClass("mx-3.5", "md:mx-[22px]", "p-0.5");
  });

  it("resizes a right-hand pane in the drag direction and supports keyboard limits", () => {
    const { divider } = renderPanels("trailing");
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
    fireEvent.pointerDown(divider, { clientX: 360, pointerId: 1, button: 0 });
    fireEvent.pointerMove(divider, { clientX: 460, pointerId: 1 });
    expect(divider).toHaveAttribute("aria-valuenow", "460");
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
    expect(divider).toHaveAttribute("aria-valuenow", "384");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "360");
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
