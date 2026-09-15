import { useState } from "react";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { reorderTabs } from "@/app/lib/reorderTabs";
import { ProjectDocumentTabs } from "./ProjectDocumentTabs";

const initialTabs = [
    { documentId: "a", filename: "First.docx" },
    { documentId: "b", filename: "Second.docx" },
    { documentId: "c", filename: "Third.docx" },
];

function Harness() {
    const [tabs, setTabs] = useState(initialTabs);
    const [activeTabId, setActiveTabId] = useState("b");
    return (
        <ProjectDocumentTabs
            tabs={tabs}
            documents={[]}
            activeTabId={activeTabId}
            onActivate={setActiveTabId}
            onClose={vi.fn()}
            onReorder={(draggedId, targetId, position) =>
                setTabs((current) =>
                    reorderTabs(
                        current,
                        draggedId,
                        targetId,
                        position,
                        (tab) => tab.documentId,
                    ),
                )
            }
        />
    );
}

function startDrag(filename: string) {
    const values = new Map<string, string>();
    const dataTransfer = {
        effectAllowed: "none",
        dropEffect: "none",
        setData: (type: string, value: string) => values.set(type, value),
        getData: (type: string) => values.get(type) ?? "",
    };
    fireEvent.dragStart(screen.getByRole("tab", { name: filename }), {
        dataTransfer,
    });
    return dataTransfer;
}

function dropOn(
    filename: string,
    dataTransfer: ReturnType<typeof startDrag>,
    clientX: number,
) {
    const target = screen.getByRole("tab", { name: filename });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 100,
    } as DOMRect);
    const over = createEvent.dragOver(target, { dataTransfer });
    Object.defineProperty(over, "clientX", { value: clientX });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("move");
    const drop = createEvent.drop(target, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: clientX });
    fireEvent(target, drop);
}

function tabOrder() {
    return screen
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label"));
}

describe("ProjectDocumentTabs", () => {
    it("uses a single tab stop and activates documents with arrow, Home and End keys", () => {
        render(<Harness />);
        const first = screen.getByRole("tab", { name: "First.docx" });
        const second = screen.getByRole("tab", { name: "Second.docx" });
        const third = screen.getByRole("tab", { name: "Third.docx" });
        expect(first.tabIndex).toBe(-1);
        expect(second.tabIndex).toBe(0);
        expect(second).toHaveAttribute(
            "aria-controls",
            "project-document-panel-b",
        );
        fireEvent.keyDown(second, { key: "ArrowRight" });
        expect(third).toHaveFocus();
        expect(third).toHaveAttribute("aria-selected", "true");
        expect(second.tabIndex).toBe(-1);
        fireEvent.keyDown(third, { key: "ArrowRight" });
        expect(first).toHaveFocus();
        fireEvent.keyDown(first, { key: "End" });
        expect(third).toHaveFocus();
        fireEvent.keyDown(third, { key: "Home" });
        expect(first).toHaveFocus();
    });

    it("reorders before and after a tab while keeping the current document selected", () => {
        render(<Harness />);
        const drag = startDrag("Third.docx");
        expect(drag.effectAllowed).toBe("move");
        dropOn("First.docx", drag, 10);
        expect(tabOrder()).toEqual(["Third.docx", "First.docx", "Second.docx"]);
        expect(
            screen.getByRole("tab", { name: "Second.docx" }),
        ).toHaveAttribute("aria-selected", "true");

        dropOn("Second.docx", startDrag("Third.docx"), 90);
        expect(tabOrder()).toEqual(["First.docx", "Second.docx", "Third.docx"]);
    });

    it("accepts dropping on the trailing space to move a tab to the end", () => {
        render(<Harness />);
        const dataTransfer = startDrag("First.docx");
        fireEvent.drop(screen.getByRole("tablist").lastElementChild!, {
            dataTransfer,
        });
        expect(tabOrder()).toEqual(["Second.docx", "Third.docx", "First.docx"]);
    });

    it("does not consume explorer-document drops", () => {
        const onReorder = vi.fn();
        render(
            <ProjectDocumentTabs
                tabs={initialTabs}
                documents={[]}
                activeTabId="b"
                onActivate={vi.fn()}
                onClose={vi.fn()}
                onReorder={onReorder}
            />,
        );
        const dataTransfer = {
            getData: (type: string) =>
                type === "application/mike-doc" ? "a" : "",
        };
        fireEvent.drop(screen.getByRole("tab", { name: "Second.docx" }), {
            dataTransfer,
        });
        expect(onReorder).not.toHaveBeenCalled();
    });

    it("supports keyboard reordering as an alternative to dragging", () => {
        render(<Harness />);
        fireEvent.keyDown(screen.getByRole("tab", { name: "Second.docx" }), {
            key: "ArrowLeft",
            altKey: true,
        });
        expect(tabOrder()).toEqual(["Second.docx", "First.docx", "Third.docx"]);
    });
});
