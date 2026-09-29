import { act, fireEvent, render, screen, within } from "@testing-library/react";
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


it("toggles native navigation from the toolbar and follows the panel close action", () => {
    const props = { bytes: new ArrayBuffer(1), mode: "edit" as const, onReady: vi.fn(), onError: vi.fn() };
    const { unmount } = render(<DocxRenderer {...props} />);
    const editor = {
        snapshot: () => ({ reviewPaneOpen: false }),
        on: vi.fn().mockReturnValue(vi.fn()),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const navigation = () => state.props.navigation as { toggle: boolean; open: boolean; onOpenChange: (open: boolean) => void };
    const button = within(screen.getByRole("toolbar")).getByRole("button", { name: "Document navigation" });
    expect(navigation().toggle).toBe(false);
    expect(navigation().open).toBe(false);
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(navigation().open).toBe(true);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(navigation().open).toBe(false);
    fireEvent.click(button);
    act(() => navigation().onOpenChange(false));
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(props.onError).not.toHaveBeenCalled();
    unmount();
    expect(screen.queryByRole("button", { name: "Document navigation" })).toBeNull();
});


it("reveals the exact unpainted body revision, including paired replacements, instead of searching repeated text", () => {
    const onReady = vi.fn();
    render(<DocxRenderer bytes={new ArrayBuffer(1)} mode="edit" onReady={onReady} onError={vi.fn()} />);
    const revision = (key: string, ids: string[], partName: string, paragraphId: string) => ({
        kind: "revision", key,
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
        scrollToBlock: vi.fn().mockReturnValue(true),
        findMatches: vi.fn(),
    };
    act(() => (state.props.onReady as (editor: unknown) => void)(editor));
    const surface = onReady.mock.calls[0][0];
    expect(surface.revealRevision(["8"])).toBe(true);
    expect(editor.scrollToBlock).toHaveBeenLastCalledWith("third-page");
    expect(surface.revealRevision(["7"])).toBe(true);
    expect(editor.scrollToBlock).toHaveBeenLastCalledWith("third-page");
    expect(surface.revealRevision(["missing"])).toBe(false);
    expect(editor.scrollToBlock).toHaveBeenCalledTimes(2);
    expect(editor.findMatches).not.toHaveBeenCalled();
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
