import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisualExportMenuUI } from "./VisualExportMenuUI";

function openMenu() {
    const trigger = screen.getByRole("button", { name: "Export visual" });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    return trigger;
}

describe("VisualExportMenuUI", () => {
    it("offers one item per callback behind a labelled trigger", () => {
        const onDownloadHtml = vi.fn();
        render(
            <VisualExportMenuUI onDownloadHtml={onDownloadHtml} onCreateDocx={vi.fn()} />,
        );

        const trigger = openMenu();
        expect(trigger).toHaveAttribute("aria-label", "Export visual");
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
            "Download HTML",
            "New Word document",
        ]);

        fireEvent.click(screen.getByRole("menuitem", { name: "Download HTML" }));
        expect(onDownloadHtml).toHaveBeenCalledOnce();
    });

    it("offers a single choice as a labelled button instead of a menu", () => {
        const onInsert = vi.fn();
        render(<VisualExportMenuUI onInsert={onInsert} />);

        expect(screen.queryByRole("button", { name: "Export visual" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Insert into document" }));
        expect(onInsert).toHaveBeenCalledOnce();
    });

    it("marks the busy item and holds the others while it runs", () => {
        render(
            <VisualExportMenuUI
                onDownloadHtml={vi.fn()}
                onDownloadPdf={vi.fn()}
                busyItem="pdf"
            />,
        );

        const trigger = openMenu();
        expect(trigger).toHaveAttribute("aria-busy", "true");
        const pdf = screen.getByRole("menuitem", { name: /Download PDF/ });
        expect(pdf).toContainElement(screen.getByRole("img", { name: "Working" }));
        expect(screen.getByRole("menuitem", { name: "Download HTML" })).toHaveAttribute("data-disabled");
    });
});
