import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
    Editor,
    ReviewItemPlacement,
    ZoomMode,
} from "@docx-editor.dev/core/contracts/editor";
import { ReviewRailContext } from "@docx-editor.dev/react";
import { DocxReviewPanel } from "./DocxReviewPanel";
import { openReviewPane } from "./docxReviewPane";

let host: HTMLDivElement;
let toolbar: HTMLDivElement;
let surface: HTMLDivElement;
let rail: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    host = document.createElement("div");
    host.className = "docx-editor";
    toolbar = document.createElement("div");
    surface = document.createElement("div");
    surface.className = "docx-paginated-surface";
    rail = document.createElement("div");
    rail.append(surface);
    host.append(toolbar, rail);
    document.body.append(host);
});
afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
});

function fixture(open = true) {
    const listeners = new Set<() => void>();
    let revision = 1;
    const editor = {
        getDocumentHandle: () => ({ revision }),
        /** A document edit; EigenPal opens the pane with a tracked one. */
        edit: (tracked: boolean) => {
            revision += 1;
            if (tracked) open = true;
            editor.emit();
        },
        on: vi.fn((_event, listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        emit: () => listeners.forEach((listener) => listener()),
        snapshot: () => ({
            editable: true,
            reviewPaneOpen: open,
            selectionCollapsed: false,
        }),
        getReviewItems: (): ReviewItemPlacement[] =>
            [
                {
                    kind: "revision",
                    key: "revision-one",
                    author: "Reviewer",
                    text: "sixty",
                    activatable: true,
                },
                {
                    kind: "comment",
                    key: "comment-two",
                    id: "2",
                    author: "Later author",
                    text: "Later comment",
                    anchorY: 900,
                    activatable: false,
                },
                {
                    kind: "comment",
                    key: "comment-one",
                    id: "1",
                    author: "Comment author",
                    text: "Keep this comment",
                    date: "2026-09-01T10:00:00Z",
                    anchorY: 120,
                    activatable: true,
                },
            ] as ReviewItemPlacement[],
        getRenderScale: () => 2,
        retainSelection: vi.fn().mockReturnValue(Symbol("selection")),
        releaseSelection: vi.fn(),
        query: vi.fn(({ type }): unknown =>
            type === "selection"
                ? {
                      from: { paragraphId: "p1", offset: 0 },
                      to: { paragraphId: "p1", offset: 16 },
                  }
                : "Selected passage",
        ),
        exec: vi.fn(() => {
            open = !open;
            editor.emit();
            return { ok: true };
        }),
        setActiveReviewItem: vi.fn().mockReturnValue({ ok: true }),
        deleteReviewItem: vi.fn().mockReturnValue({ ok: true }),
    };
    return editor;
}
function view(editor: ReturnType<typeof fixture>) {
    return (
        <DocxReviewPanel
            editor={editor as unknown as Editor}
            author="Reviewer"
            toolbar={toolbar}
            surface={surface}
            rail={rail}
        />
    );
}

it("docks comment bubbles in a column beside the viewport, in document order, without revisions", () => {
    render(view(fixture()));
    const column = screen.getByRole("complementary", {
        name: "Document comments",
    });
    expect(rail.lastElementChild).toBe(column);
    expect(surface).not.toContainElement(column);
    expect(screen.getByRole("heading", { name: "Comments" })).toBeVisible();
    const bubbles = screen.getAllByRole("region", { name: /^Comment by / });
    expect(bubbles.map((bubble) => bubble.getAttribute("aria-label"))).toEqual(
        ["Comment by Comment author", "Comment by Later author"],
    );
    expect(bubbles[0]).not.toHaveAttribute("style");
    expect(screen.queryByText("sixty")).toBeNull();
});

it("closes the column from its header", () => {
    const editor = fixture();
    render(view(editor));
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "toggleReviewPane" });
    expect(screen.queryByRole("complementary")).toBeNull();
});

it("registers space only while comments are shown and follows the native toolbar toggle", () => {
    const editor = fixture(false);
    const unregister = vi.fn();
    const registry = {
        mounted: 0,
        register: vi.fn(() => unregister),
        registerCommentDraft: vi.fn(),
        requestCommentDraft: vi.fn(),
    };
    render(
        <ReviewRailContext.Provider value={registry}>
            {view(editor)}
        </ReviewRailContext.Provider>,
    );
    expect(screen.queryByText("Keep this comment")).toBeNull();
    expect(registry.register).not.toHaveBeenCalled();
    act(() => {
        editor.exec();
    });
    expect(screen.getByText("Keep this comment")).toBeVisible();
    expect(registry.register).toHaveBeenCalledOnce();
    fireEvent.keyDown(
        screen.getByRole("complementary", { name: "Document comments" }),
        { key: "Escape" },
    );
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "toggleReviewPane" });
    expect(unregister).toHaveBeenCalledOnce();
    expect(screen.queryByText("Keep this comment")).toBeNull();
});

it("scrolls to a comment when its card is clicked, and reports refusals without engine messages", () => {
    const editor = fixture();
    render(view(editor));
    fireEvent.click(screen.getByText("Keep this comment"));
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith("comment-one");
    expect(
        screen.queryByRole("button", { name: /show in document|view/i }),
    ).toBeNull();
    editor.setActiveReviewItem.mockReturnValue({
        ok: false,
        error: { message: "internal detail" },
    });
    fireEvent.click(screen.getByText("Keep this comment"));
    expect(screen.getByRole("alert")).toHaveTextContent(
        "This comment could not be shown in the document.",
    );
    expect(screen.queryByText("internal detail")).toBeNull();
});

it("opens a reply form from the card's Reply button without jumping the page", () => {
    const editor = fixture();
    render(view(editor));
    const card = screen.getByRole("region", {
        name: "Comment by Comment author",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    expect(
        within(card).getByRole("textbox", { name: "Reply to comment" }),
    ).toHaveFocus();
    expect(editor.setActiveReviewItem).not.toHaveBeenCalled();
});

it("offers Edit only for the author's own last comment, and Delete for each entry", async () => {
    const editor = fixture();
    render(view(editor));
    fireEvent.pointerDown(
        screen.getByRole("button", {
            name: "Actions for comment by Comment author",
        }),
        { button: 0, ctrlKey: false },
    );
    expect(
        await screen.findByRole("menuitem", { name: "Edit" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(editor.deleteReviewItem).toHaveBeenCalledWith("comment-one");
    expect(editor.setActiveReviewItem).not.toHaveBeenCalled();
});

it("edits the author's own comment in place from the card menu", async () => {
    const editor = fixture();
    const own = {
        kind: "comment",
        key: "comment-mine",
        id: "3",
        author: "Reviewer",
        text: "Draft wording",
        anchorY: 1200,
        activatable: true,
        readOnly: false,
        replyIds: [],
        item: {
            range: {
                partName: "/word/document.xml",
                start: { paragraphId: "p9", offset: 2 },
                end: { paragraphId: "p9", offset: 8 },
            },
            orphaned: false,
        },
    };
    let items = [...editor.getReviewItems(), own] as ReviewItemPlacement[];
    editor.getReviewItems = () => items;
    const calls: string[] = [];
    editor.exec = vi.fn((command: { type: string }) => {
        calls.push(command.type);
        return { ok: true };
    }) as unknown as typeof editor.exec;
    Object.assign(editor, {
        addComment: vi.fn((text: string) => {
            calls.push("add");
            items = [
                ...items,
                { ...own, key: "comment-new", id: "4", text },
            ] as ReviewItemPlacement[];
            return { ok: true };
        }),
        deleteReviewItem: vi.fn((key: string) => {
            calls.push(`delete ${key}`);
            items = items.filter((item) => item.key !== key);
            return { ok: true };
        }),
    });
    render(view(editor));
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Actions for comment by Reviewer" }),
        { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const input = await screen.findByRole("textbox", { name: "Edit comment" });
    expect(input).toHaveValue("Draft wording");
    fireEvent.change(input, { target: { value: "Final wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls).toEqual(["setSelection", "add", "delete comment-mine"]);
    expect(editor.exec).toHaveBeenCalledWith({
        type: "setSelection",
        range: {
            anchor: { paragraphId: "p9", offset: 2 },
            head: { paragraphId: "p9", offset: 8 },
        },
    });
});

it("keeps New comment as a separate popup, preserves repeat clicks, and cancels on Escape", async () => {
    const editor = fixture(false);
    const { unmount } = render(view(editor));
    const button = screen.getByRole("button", { name: "New comment" });
    fireEvent.click(button);
    expect(editor.exec).not.toHaveBeenCalled();
    const popup = screen.getByRole("dialog", { name: "New comment" });
    expect(popup).toBeVisible();
    expect(surface).not.toContainElement(popup);
    const input = screen.getByRole("textbox", { name: "New comment" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(button);
    expect(input).toHaveValue("Keep this draft");
    expect(editor.retainSelection).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editor.releaseSelection).toHaveBeenCalledOnce();
    unmount();
    expect(toolbar).toBeEmptyDOMElement();
});

it.each(["missing selection", "collapsed selection", "failed capture"])(
    "shows popup feedback for %s",
    (failure) => {
        const editor = fixture(false);
        if (failure === "missing selection") editor.query.mockReturnValue(null);
        if (failure === "collapsed selection")
            editor.snapshot = () => ({
                editable: true,
                reviewPaneOpen: false,
                selectionCollapsed: true,
            });
        editor.retainSelection.mockReturnValue(null);
        render(view(editor));
        fireEvent.click(screen.getByRole("button", { name: "New comment" }));
        expect(
            screen.getByRole("dialog", { name: "New comment" }),
        ).toBeVisible();
        expect(editor.exec).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toHaveTextContent(
            failure === "failed capture"
                ? "Select the passage again"
                : "Select text in the document",
        );
    },
);

it.each([false, true])(
    "restores fitted zoom on close while preserving a manual zoom: %s",
    (manual) => {
        const base = fixture();
        const original: ZoomMode = {
            type: "fit",
            fit: "pageWidth",
            minZoom: 0.1,
            maxZoom: 1,
        };
        let mode: ZoomMode = original;
        const editor = {
            ...base,
            snapshot: () => ({ ...base.snapshot(), zoomMode: mode }),
            setZoomMode: vi.fn((next: ZoomMode) => {
                mode = next;
                return { ok: true };
            }),
        };
        render(view(editor));
        expect(editor.setZoomMode).toHaveBeenCalledWith({
            ...original,
            minZoom: 0.4,
        });
        if (manual) mode = { type: "fixed" };
        act(() => {
            editor.exec();
        });
        expect(mode).toEqual(manual ? { type: "fixed" } : original);
    },
);

it("offers reply and delete when a bubble in the column is right-clicked", async () => {
    const editor = fixture();
    render(view(editor));
    fireEvent.contextMenu(
        screen.getByRole("region", { name: "Comment by Comment author" }),
        { clientX: 20, clientY: 30 },
    );
    expect(
        await screen.findByRole("menuitem", { name: "Reply to comment" }),
    ).toBeVisible();
    expect(
        screen.getByRole("menuitem", { name: "Delete comment" }),
    ).toBeVisible();
});

it("scrolls the active thread into view inside the column", () => {
    const base = fixture();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const editor = {
        ...base,
        getReviewItems: () =>
            base
                .getReviewItems()
                .map((item) =>
                    item.key === "comment-two" ? { ...item, isActive: true } : item,
                ),
    };
    render(view(editor as typeof base));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(
        screen.getByRole("region", { name: "Comment by Later author" }),
    );
});

it("shows when each comment was written, and nothing when the file has no date", () => {
    render(view(fixture()));
    const dated = screen.getByRole("region", {
        name: "Comment by Comment author",
    });
    const time = dated.querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-09-01T10:00:00Z");
    expect(time).toHaveTextContent("2026");
    expect(
        screen
            .getByRole("region", { name: "Comment by Later author" })
            .querySelector("time"),
    ).toBeNull();
});

it("opens the column and focuses the bubble when View comment is chosen on a highlight", async () => {
    const editor = fixture(false);
    surface.innerHTML =
        '<span>Commented text</span><div class="docx-comment-overlay"><div class="docx-comment-band docx-comment-band--active"></div></div>';
    const band = surface.querySelector<HTMLElement>(".docx-comment-band")!;
    band.getBoundingClientRect = () => new DOMRect(10, 20, 200, 12);
    const items = editor.getReviewItems;
    editor.getReviewItems = () =>
        items().map((item) =>
            item.key === "comment-one" ? { ...item, isActive: true } : item,
        ) as ReviewItemPlacement[];
    render(view(editor));
    fireEvent.contextMenu(surface.firstElementChild!, {
        clientX: 50,
        clientY: 25,
    });
    fireEvent.click(
        await screen.findByRole("menuitem", { name: "View comment" }),
    );
    await waitFor(() =>
        expect(
            screen.getByRole("region", { name: "Comment by Comment author" }),
        ).toHaveFocus(),
    );
    expect(editor.exec).toHaveBeenCalledWith({ type: "toggleReviewPane" });
});

it("keeps the column closed when an edit opens the pane by itself", () => {
    const editor = fixture(false);
    render(view(editor));

    act(() => editor.edit(true));

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(editor.exec).toHaveBeenCalledOnce();
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "toggleReviewPane" });
    expect(editor.snapshot().reviewPaneOpen).toBe(false);
});

it("still opens for the toolbar toggle and stays open while typing", () => {
    const editor = fixture(false);
    render(view(editor));

    act(() => {
        editor.exec();
    });
    expect(
        screen.getByRole("complementary", { name: "Document comments" }),
    ).toBeVisible();

    act(() => editor.edit(true));
    expect(
        screen.getByRole("complementary", { name: "Document comments" }),
    ).toBeVisible();
    expect(editor.exec).toHaveBeenCalledOnce();
});

it("opens for an announced request made in the same step as an edit", () => {
    const editor = fixture(false);
    render(view(editor));

    act(() => {
        editor.edit(false);
        openReviewPane(editor as unknown as Editor);
    });

    expect(
        screen.getByRole("complementary", { name: "Document comments" }),
    ).toBeVisible();
    expect(editor.snapshot().reviewPaneOpen).toBe(true);
});
