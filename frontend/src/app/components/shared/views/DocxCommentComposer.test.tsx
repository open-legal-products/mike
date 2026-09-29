import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import {
    DocxCommentComposer,
    docxSelectionAnchor,
} from "./DocxCommentComposer";

vi.mock("@docx-editor.dev/react", () => ({ useEditorSnapshot: vi.fn() }));

let toolbar: HTMLDivElement;
beforeEach(() => {
    toolbar = document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    document.body.append(toolbar);
});
afterEach(() => {
    toolbar.remove();
});

function fixture() {
    return {
        snapshot: () => ({
            editable: true,
            editingMode: "editing",
            reviewPaneOpen: true,
        }),
        getSelectionPlacement: vi
            .fn()
            .mockReturnValue({ anchorY: 50, pageIndex: 0 }),
        query: vi.fn(({ type }) =>
            type === "selection"
                ? {
                      from: { paragraphId: "p1", offset: 0 },
                      to: { paragraphId: "p1", offset: 19 },
                  }
                : ("The selected clause" as string),
        ),
        retainSelection: vi.fn().mockReturnValue(Symbol("selection")),
        releaseSelection: vi.fn(),
        addComment: vi.fn().mockReturnValue({ ok: true, changed: true }),
    };
}

it("pins the selected passage while typing and creates one authored comment", async () => {
    const editor = fixture();
    const user = userEvent.setup();
    render(
        <DocxCommentComposer
            toolbar={toolbar}
            editor={editor as unknown as Editor}
            author="Reviewer"
        />,
    );
    await user.click(screen.getByRole("button", { name: "New comment" }));
    const textbox = screen.getByRole("textbox", { name: "New comment" });
    expect(textbox).toHaveFocus();
    expect(editor.retainSelection).toHaveBeenCalledOnce();
    expect(screen.queryByText(/The selected clause/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    await user.type(textbox, "Please clarify this clause.");
    expect(editor.addComment).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(editor.addComment).toHaveBeenCalledExactlyOnceWith(
        "Please clarify this clause.",
        "Reviewer",
    );
    expect(editor.releaseSelection).toHaveBeenCalledExactlyOnceWith(
        editor.retainSelection.mock.results[0].value,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Comment added.");
});

it.each(["refusal", "exception"])(
    "keeps the draft and anchor after a %s, allowing a retry",
    async (failure) => {
        const editor = fixture();
        if (failure === "refusal")
            editor.addComment.mockReturnValueOnce({
                ok: false,
                reason: "private engine detail",
            });
        else
            editor.addComment.mockImplementationOnce(() => {
                throw new Error("private engine detail");
            });
        const user = userEvent.setup();
        render(
            <DocxCommentComposer
                toolbar={toolbar}
                editor={editor as unknown as Editor}
                author="Reviewer"
            />,
        );
        await user.click(screen.getByRole("button", { name: "New comment" }));
        await user.type(screen.getByRole("textbox"), "Keep my draft");
        await user.click(screen.getByRole("button", { name: "Add comment" }));
        expect(screen.getByRole("textbox")).toHaveValue("Keep my draft");
        expect(screen.getByRole("alert")).not.toHaveTextContent(
            "private engine detail",
        );
        expect(editor.releaseSelection).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Add comment" }));
        expect(editor.addComment).toHaveBeenLastCalledWith(
            "Keep my draft",
            "Reviewer",
        );
        expect(screen.queryByRole("alert")).toBeNull();
    },
);

it("releases its own anchor on cancellation and unmount without creating a comment", async () => {
    const editor = fixture();
    const user = userEvent.setup();
    const { unmount } = render(
        <DocxCommentComposer
            toolbar={toolbar}
            editor={editor as unknown as Editor}
            author="Reviewer"
        />,
    );
    await user.click(screen.getByRole("button", { name: "New comment" }));
    await user.type(screen.getByRole("textbox"), "Discard this");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editor.releaseSelection).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "New comment" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    unmount();
    expect(editor.releaseSelection).toHaveBeenCalledTimes(2);
    expect(editor.addComment).not.toHaveBeenCalled();
});

it.each(["author", "read-only"])(
    "requires %s before starting a comment",
    async (missing) => {
        const editor = fixture();
        if (missing === "read-only")
            editor.snapshot = () => ({
                editable: true,
                editingMode: "viewing",
                reviewPaneOpen: true,
            });
        render(
            <DocxCommentComposer
                toolbar={toolbar}
                editor={editor as unknown as Editor}
                author={missing === "author" ? undefined : "Reviewer"}
            />,
        );
        expect(
            screen.getByRole("button", { name: "New comment" }),
        ).toBeDisabled();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(editor.retainSelection).not.toHaveBeenCalled();
    },
);

it("refuses blank drafts and a document that becomes read-only while composing", async () => {
    const editor = fixture();
    const user = userEvent.setup();
    const view = () => (
        <DocxCommentComposer
            toolbar={toolbar}
            editor={editor as unknown as Editor}
            author="Reviewer"
        />
    );
    const { rerender } = render(view());
    await user.click(screen.getByRole("button", { name: "New comment" }));
    await user.type(screen.getByRole("textbox"), "   ");
    fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Enter",
        ctrlKey: true,
    });
    expect(editor.addComment).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox"), "Draft");
    editor.snapshot = () => ({
        editable: false,
        editingMode: "viewing",
        reviewPaneOpen: true,
    });
    rerender(view());
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Enter",
        ctrlKey: true,
    });
    expect(editor.addComment).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("   Draft");
});

it("preserves the draft instead of silently attaching it to a different passage", async () => {
    const editor = fixture();
    const user = userEvent.setup();
    render(
        <DocxCommentComposer
            toolbar={toolbar}
            editor={editor as unknown as Editor}
            author="Reviewer"
        />,
    );
    await user.click(screen.getByRole("button", { name: "New comment" }));
    await user.type(
        screen.getByRole("textbox"),
        "Keep this anchored to the original clause",
    );
    editor.query.mockImplementation(({ type }) =>
        type === "selection"
            ? {
                  from: { paragraphId: "p2", offset: 0 },
                  to: { paragraphId: "p2", offset: 19 },
              }
            : "A different selection",
    );
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(editor.addComment).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(
        "Keep this anchored to the original clause",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
        "The selected passage changed.",
    );
});

it("starts a comment from a model selection without a screen placement", () => {
    const editor = fixture();
    editor.getSelectionPlacement.mockReturnValue(null);
    render(
        <DocxCommentComposer
            toolbar={toolbar}
            editor={editor as unknown as Editor}
            author="Reviewer"
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New comment" }));
    expect(screen.getByRole("textbox", { name: "New comment" })).toHaveFocus();
    expect(editor.retainSelection).toHaveBeenCalledOnce();
});

it("anchors the composer under the last painted line of the selection", () => {
    const surface = document.createElement("div");
    const overlay = document.createElement("div");
    overlay.className = "docx-selection-overlay";
    surface.append(overlay);
    const line = (left: number, top: number, width: number) => {
        const rect = document.createElement("div");
        for (const [name, value] of Object.entries({
            offsetLeft: left,
            offsetTop: top,
            offsetWidth: width,
            offsetHeight: 12,
        }))
            Object.defineProperty(rect, name, { value });
        overlay.append(rect);
    };
    line(120, 100, 300);
    line(40, 112, 380);
    line(40, 124, 90);
    expect(docxSelectionAnchor(surface)).toEqual({
        left: 40,
        top: 136,
        width: 90,
    });
    overlay.replaceChildren();
    // Unpainted (virtualized) selections fall back to the toolbar button.
    expect(docxSelectionAnchor(surface)).toBeNull();
});
