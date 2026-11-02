import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTabBar } from "./DocumentTabBar";

const tabs = [
    { id: "a", title: "lease.docx" },
    { id: "b", title: "minutes.pdf" },
];

function rect(left: number, right: number): DOMRect {
    return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) };
}

/** Lays the strip out at 0–200px with each tab where `tabRects` puts it. */
function layOut(tabRects: Record<string, [number, number]>) {
    return vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
            if (this.getAttribute("role") === "tablist") return rect(0, 200);
            const id = Object.keys(tabRects).find(
                (key) =>
                    this.id === `doc-tab-${key}` ||
                    this.querySelector(`#doc-tab-${key}`),
            );
            return id ? rect(...tabRects[id]) : rect(0, 0);
        });
}

function renderBar(activeTabId: string) {
    const scrollBy = vi.fn();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(
        <DocumentTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            label="Documents"
            idPrefix="doc"
            onActivate={vi.fn()}
            onClose={vi.fn()}
        />,
    );
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    return { scrollBy, scrollIntoView };
}

describe("DocumentTabBar active tab", () => {
    afterEach(() => vi.restoreAllMocks());

    it("scrolls its own strip to a tab hidden past the end, never the page", () => {
        layOut({ a: [0, 120], b: [124, 260] });
        const { scrollBy, scrollIntoView } = renderBar("b");

        expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: "smooth" });
        // scrollIntoView would scroll every ancestor too: while the panel
        // holding the bar slides in, that drags the whole page sideways.
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("scrolls back to a tab hidden before the start", () => {
        layOut({ a: [-80, 40], b: [44, 180] });
        const { scrollBy } = renderBar("a");

        expect(scrollBy).toHaveBeenCalledWith({ left: -80, behavior: "smooth" });
    });

    it("leaves the strip alone when the tab is already in view", () => {
        layOut({ a: [0, 90], b: [94, 190] });
        const { scrollBy, scrollIntoView } = renderBar("b");

        expect(scrollBy).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});
