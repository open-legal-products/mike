import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { docxModules } from "@/app/lib/docxReviewModule";
import DocxRenderer from "./EigenpalDocxRenderer";

const state = vi.hoisted(() => ({
    props: {} as Record<string, unknown>,
    user: { id: "user-1", email: "reviewer@example.test" } as { id: string; email: string } | null,
    name: "Signed-in reviewer" as string | null,
}));
vi.mock("@docx-editor.dev/react", () => ({ DocxEditor: (props: Record<string, unknown>) => { state.props = props; return <div><div className="docx-toolbar" role="toolbar" /><div className="docx-paginated-surface" /><div className="docx-editor__scroll-container" /></div>; } }));
vi.mock("@docx-editor.dev/fonts", () => ({ packagedFonts: () => ({}) }));
vi.mock("./DocxReviewPanel", () => ({ DocxReviewPanel: () => null }));
vi.mock("@/app/contexts/AuthContext", () => ({ useOptionalAuth: () => ({ user: state.user }) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useOptionalUserProfile: () => ({ profile: { displayName: state.name } }) }));

it("registers the open-source review module and updates author without replacing document bytes", () => {
    const props = { bytes: new ArrayBuffer(1), mode: "edit" as const, onReady: vi.fn(), onError: vi.fn(), onChange: vi.fn() };
    const { rerender } = render(<DocxRenderer {...props} />);
    const document = state.props.document;
    expect(state.props.modules).toBe(docxModules);
    expect(state.props.i18n).toEqual({ formattingBar: { commentsAndChanges: "Comments" } });
    expect(state.props.author).toBe("Signed-in reviewer");
    expect(state.props.onChange).toBe(props.onChange);
    state.name = null;
    rerender(<DocxRenderer {...props} />);
    expect(state.props.author).toBe("reviewer@example.test");
    expect(state.props.document).toBe(document);
    state.user = null;
    rerender(<DocxRenderer {...props} />);
    expect(state.props.author).toBeUndefined();
    rerender(<DocxRenderer {...props} author="Standalone reviewer" />);
    expect(state.props.author).toBe("Standalone reviewer");
});


it("locks the native editor when Edit is off without replacing its document", () => {
    const props = { bytes: new ArrayBuffer(1), mode: "edit" as const, onReady: vi.fn(), onError: vi.fn() };
    const { rerender } = render(<DocxRenderer {...props} toolbarVisible={false} />);
    const document = state.props.document;
    expect(state.props.mode).toBe("view");
    rerender(<DocxRenderer {...props} toolbarVisible />);
    expect(state.props.mode).toBe("edit");
    expect(state.props.document).toBe(document);
    rerender(<DocxRenderer {...props} toolbarVisible={false} />);
    expect(state.props.mode).toBe("view");
    expect(state.props.document).toBe(document);
    rerender(<DocxRenderer {...props} mode="view" toolbarVisible />);
    expect(state.props.mode).toBe("view");
});

it("toggles navigation from More and follows the panel close action", async () => {
    const user = userEvent.setup();
    const props = { bytes: new ArrayBuffer(1), mode: "edit" as const, onReady: vi.fn(), onError: vi.fn() };
    const { unmount } = render(<DocxRenderer {...props} />);
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const navigation = () => state.props.navigation as { toggle: boolean; open: boolean; onOpenChange: (open: boolean) => void };
    const more = within(screen.getByRole("toolbar")).getByRole("button", { name: "More" });
    expect(navigation().toggle).toBe(false);
    expect(navigation().open).toBe(false);
    expect(screen.queryByRole("button", { name: "Document navigation" })).toBeNull();
    await user.click(more);
    expect(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" }));
    expect(navigation().open).toBe(true);
    await user.click(more);
    expect(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" }));
    expect(navigation().open).toBe(false);
    await user.click(more);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" }));
    act(() => navigation().onOpenChange(false));
    await user.click(more);
    expect(screen.getByRole("menuitemcheckbox", { name: "Navigation pane" })).toHaveAttribute("aria-checked", "false");
    expect(props.onError).not.toHaveBeenCalled();
    unmount();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Navigation pane" })).toBeNull();
});


it("activates the exact native body revision, including paired replacements, and clears only its own highlight", () => {
    const onReady = vi.fn();
    render(<DocxRenderer bytes={new ArrayBuffer(1)} mode="edit" onReady={onReady} onError={vi.fn()} />);
    const revision = (key: string, ids: string[], partName: string, paragraphId: string) => ({
        kind: "revision", key, isActive: false,
        item: { addresses: ids.map((id) => ({ id })), ranges: [{ partName, start: { paragraphId } }] },
    });
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
        getReviewItems: () => [
            revision("header", ["8"], "/word/header1.xml", "header-paragraph"),
            revision("other", ["18"], "/word/document.xml", "first-page"),
            revision("replacement", ["7", "8"], "/word/document.xml", "third-page"),
        ],
        setActiveReviewItem: vi.fn().mockReturnValue({ ok: true }),
        findMatches: vi.fn(),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const surface = onReady.mock.calls[0][0];
    expect(surface.activateRevision({ ins: "8", del: "7" })).toBe(true);
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith("replacement", { reveal: "center" });
    expect(surface.activateRevision({ ins: "18" })).toBe(true);
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith("other", { reveal: "center" });
    expect(surface.activateRevision({ ins: "missing" })).toBe(false);
    expect(editor.setActiveReviewItem).toHaveBeenCalledTimes(2);
    expect(editor.findMatches).not.toHaveBeenCalled();
    // A user moving to another review item must retain that activation.
    surface.clearRevisionHighlight();
    expect(editor.setActiveReviewItem).toHaveBeenCalledTimes(2);
    surface.activateRevision({ ins: "8", del: "7" });
    vi.spyOn(editor, "getReviewItems").mockReturnValue([
        { ...revision("replacement", ["7", "8"], "/word/document.xml", "third-page"), isActive: true },
    ]);
    surface.clearRevisionHighlight();
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith(null);
    editor.setActiveReviewItem.mockReturnValueOnce({ ok: false });
    expect(surface.activateRevision({ ins: "8", del: "7" })).toBe(false);

});

it.each([
    { ids: { ins: "8" }, anchor: 12, head: 20 },
    { ids: { del: "7" }, anchor: 4, head: 12 },
])("selects only the $ids half of a native replacement that pairs it with another edit", ({ ids, anchor, head }) => {
    const onReady = vi.fn();
    render(<DocxRenderer bytes={new ArrayBuffer(1)} mode="edit" onReady={onReady} onError={vi.fn()} />);
    const position = (offset: number) => ({ paragraphId: "p", offset });
    const range = (start: number, end: number) => ({ partName: "/word/document.xml", start: position(start), end: position(end) });
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
        // An unrelated deletion directly before this insertion, with no space between them.
        getReviewItems: () => [{
            kind: "revision", key: "paired", isActive: false,
            item: {
                revisionKind: "replace", replacedRangeCount: 1,
                addresses: [{ id: "7" }, { id: "8" }], ranges: [range(4, 12), range(12, 20)],
            },
        }],
        setActiveReviewItem: vi.fn().mockReturnValue({ ok: true }),
        exec: vi.fn().mockReturnValue({ ok: true }),
        query: vi.fn(() => "edit"),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const surface = onReady.mock.calls[0][0];
    expect(surface.activateRevision(ids)).toBe(true);
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith(null);
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "setSelection", range: { anchor: position(anchor), head: position(head) } });
});

it.each([false, true])("selects both separated revision ranges across paragraphs=%s and preserves subsequent user selection", (crossParagraphs) => {
    const onReady = vi.fn();
    render(<DocxRenderer bytes={new ArrayBuffer(1)} mode="edit" onReady={onReady} onError={vi.fn()} />);
    const anchor = { paragraphId: "first", offset: 7 };
    const head = { paragraphId: crossParagraphs ? "last" : "first", offset: 80 };
    const revision = (key: string, id: string, start: typeof anchor, end: typeof anchor) => ({
        kind: "revision", key, isActive: false,
        item: { addresses: [{ id }], ranges: [{ partName: "/word/document.xml", start, end }] },
    });
    let selectedText = "";
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
        // Native document order, independent of the caller's insertion/deletion ID order.
        getReviewItems: () => [
            revision("deletion", "7", anchor, { ...anchor, offset: 35 }),
            revision("insertion", "8", { ...head, offset: 50 }, head),
        ],
        setActiveReviewItem: vi.fn().mockReturnValue({ ok: true }),
        exec: vi.fn(() => { selectedText = "deleted text with a gap then inserted text"; return { ok: true }; }),
        query: vi.fn(() => selectedText),
        findMatches: vi.fn(),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const surface = onReady.mock.calls[0][0];
    expect(surface.activateRevision({ ins: "8", del: "7" })).toBe(true);
    expect(editor.setActiveReviewItem).toHaveBeenCalledWith("deletion", { reveal: "center" });
    expect(editor.setActiveReviewItem).toHaveBeenLastCalledWith(null);
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "setSelection", range: { anchor, head } });
    expect(editor.findMatches).not.toHaveBeenCalled();
    surface.clearRevisionHighlight();
    expect(editor.exec).toHaveBeenLastCalledWith({ type: "setSelection", range: { anchor, head: anchor } });
    surface.activateRevision({ ins: "8", del: "7" });
    selectedText = "A later user selection";
    editor.exec.mockClear();
    surface.clearRevisionHighlight();
    expect(editor.exec).not.toHaveBeenCalled();
    editor.exec.mockReturnValueOnce({ ok: false });
    expect(surface.activateRevision({ ins: "8", del: "7" })).toBe(false);
});

it("selects across table cells, scrolls to the first cell, and clears the complete citation on deselect", () => {
    const onReady = vi.fn();
    render(<DocxRenderer bytes={new ArrayBuffer(1)} mode="edit" onReady={onReady} onError={vi.fn()} />);
    let selectedText = "";
    const first = { blockId: "first-cell", paragraphIndex: 0, start: 0, length: 2, text: "P1" };
    const last = { blockId: "last-cell", paragraphIndex: 1, start: 2, length: 5, text: "hours" };
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
        findMatches: (text: string) => text === "P1" ? [first] : text === "hours" ? [last] : [],
        query: ({ type }: { type: string }) => type === "paragraphs"
            ? [{ text: "P1" }, { text: "4 hours" }] : selectedText,
        selectMatch: vi.fn().mockReturnValue({ ok: true }),
        exec: vi.fn(() => { selectedText = "P1\n4 hours"; return { ok: true }; }),
        scrollToBlock: vi.fn(),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const surface = onReady.mock.calls[0][0];
    // Citation whitespace may differ from the native selected text.
    expect(surface.selectText("P1 4 hours")).toBe(true);
    expect(editor.exec).toHaveBeenCalledWith({ type: "setSelection", range: {
        anchor: { paragraphId: "first-cell", offset: 0 },
        head: { paragraphId: "last-cell", offset: 7 },
    } });
    expect(editor.scrollToBlock).toHaveBeenCalledWith("first-cell");
    surface.clearTextSelection();
    expect(editor.selectMatch).toHaveBeenLastCalledWith({ ...first, length: 0 });

    surface.selectText("P1 4 hours");
    selectedText = "User selected something else";
    editor.selectMatch.mockClear();
    surface.clearTextSelection();
    expect(editor.selectMatch).not.toHaveBeenCalled();

    editor.exec.mockReturnValueOnce({ ok: false });
    expect(surface.selectText("P1 4 hours")).toBe(false);
    expect(editor.selectMatch).toHaveBeenLastCalledWith({ ...first, length: 0 });
});
