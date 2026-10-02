import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { DocxCommentReply } from "./DocxCommentReply";
vi.mock("@docx-editor.dev/react", () => ({ useEditorSnapshot: vi.fn() }));
function fixture() {
    return {
        snapshot: () => ({ editable: true }),
        replyToReviewItem: vi.fn().mockReturnValue({ ok: true }),
    };
}
it("focuses the reply field and writes an authored reply to the specified comment", () => {
    const editor = fixture();
    const close = vi.fn();
    render(
        <DocxCommentReply
            editor={editor as unknown as Editor}
            commentKey="comment-7"
            author="Reviewer"
            onClose={close}
        />,
    );
    const input = screen.getByRole("textbox", { name: "Reply to comment" });
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Clarification  " } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(editor.replyToReviewItem).toHaveBeenCalledExactlyOnceWith(
        "comment-7",
        "Clarification",
        "Reviewer",
    );
    expect(close).toHaveBeenCalledOnce();
});
it("keeps a failed reply draft and cancels on Escape without editing the document", () => {
    const editor = fixture();
    editor.replyToReviewItem.mockReturnValue({ ok: false });
    const close = vi.fn();
    render(
        <DocxCommentReply
            editor={editor as unknown as Editor}
            commentKey="comment-7"
            author="Reviewer"
            onClose={close}
        />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Keep this reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(input).toHaveValue("Keep this reply");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
});
