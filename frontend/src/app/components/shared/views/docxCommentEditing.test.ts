import { expect, it, vi } from "vitest";
import type {
    Editor,
    ReviewCommentPlacement,
    ReviewItemPlacement,
} from "@docx-editor.dev/core/contracts/editor";
import { docxCommentEditable, docxEditComment } from "./docxCommentEditing";

const range = {
    partName: "/word/document.xml",
    start: { paragraphId: "p1", offset: 0 },
    end: { paragraphId: "p1", offset: 5 },
};

function comment(
    overrides: Partial<Record<string, unknown>> = {},
): ReviewCommentPlacement {
    return {
        kind: "comment",
        key: "comment-1",
        id: "1",
        author: "Me",
        text: "Original",
        readOnly: false,
        resolved: false,
        replyIds: [],
        item: { range, orphaned: false },
        ...overrides,
    } as unknown as ReviewCommentPlacement;
}

const root = comment({ replyIds: ["2", "3"], author: "Other" });
const firstReply = comment({ key: "comment-2", id: "2", parentId: "1" });
const lastReply = comment({ key: "comment-3", id: "3", parentId: "1" });
const thread = [root, firstReply, lastReply];

it("allows editing only the author's own comment with nothing after it in the thread", () => {
    expect(docxCommentEditable(comment(), [comment()], "Me")).toBe(true);
    expect(docxCommentEditable(lastReply, thread, "Me")).toBe(true);
    // Replacing these would reorder the thread or drop others' replies.
    expect(docxCommentEditable(firstReply, thread, "Me")).toBe(false);
    expect(
        docxCommentEditable(comment({ replyIds: ["2"] }), thread, "Me"),
    ).toBe(false);
    expect(docxCommentEditable(comment(), [comment()], "Someone else")).toBe(
        false,
    );
    expect(docxCommentEditable(comment(), [comment()], undefined)).toBe(false);
    expect(
        docxCommentEditable(comment({ readOnly: true }), [comment()], "Me"),
    ).toBe(false);
    expect(
        docxCommentEditable(
            comment({ item: { range: { ...range, partName: "/word/header1.xml" }, orphaned: false } }),
            [comment()],
            "Me",
        ),
    ).toBe(false);
});

function fakeEditor(initial: ReviewItemPlacement[]) {
    let items = initial;
    const editor = {
        getReviewItems: () => items,
        exec: vi.fn().mockReturnValue({ ok: true }),
        addComment: vi.fn((text: string) => {
            items = [...items, comment({ key: "comment-9", id: "9", text })];
            return { ok: true };
        }),
        replyToReviewItem: vi.fn((_key: string, text: string) => {
            items = [
                ...items,
                comment({ key: "comment-9", id: "9", parentId: "1", text }),
            ];
            return { ok: true };
        }),
        setCommentResolved: vi.fn().mockReturnValue({ ok: true }),
        deleteReviewItem: vi.fn((key: string) => {
            items = items.filter((item) => item.key !== key);
            return { ok: true };
        }),
    };
    return editor;
}

it("replaces the last reply at the end of its thread", () => {
    const editor = fakeEditor(thread);
    expect(
        docxEditComment(editor as unknown as Editor, lastReply, "New", "Me"),
    ).toBe(true);
    expect(editor.replyToReviewItem).toHaveBeenCalledWith(
        "comment-1",
        "New",
        "Me",
    );
    expect(editor.getReviewItems().map((item) => item.key)).toEqual([
        "comment-1",
        "comment-2",
        "comment-9",
    ]);
});

it("keeps a resolved root comment resolved", () => {
    const resolved = comment({ resolved: true });
    const editor = fakeEditor([resolved]);
    docxEditComment(editor as unknown as Editor, resolved, "New", "Me");
    expect(editor.setCommentResolved).toHaveBeenCalledWith("comment-9", true);
});

it("keeps the original comment when the replacement cannot be written", () => {
    const editor = fakeEditor([comment()]);
    editor.addComment.mockReturnValue({ ok: false });
    expect(
        docxEditComment(editor as unknown as Editor, comment(), "New", "Me"),
    ).toBe(false);
    expect(editor.deleteReviewItem).not.toHaveBeenCalled();
});

it("removes the replacement when the original cannot be deleted", () => {
    const editor = fakeEditor([comment()]);
    editor.deleteReviewItem
        .mockReturnValueOnce({ ok: false })
        .mockReturnValueOnce({ ok: true });
    expect(
        docxEditComment(editor as unknown as Editor, comment(), "New", "Me"),
    ).toBe(false);
    expect(editor.deleteReviewItem).toHaveBeenLastCalledWith("comment-9");
});
