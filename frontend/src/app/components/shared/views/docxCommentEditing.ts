import type {
    Editor,
    ReviewCommentPlacement,
    ReviewItemPlacement,
} from "@docx-editor.dev/core/contracts/editor";

const BODY_PART = "/word/document.xml";

function commentsOf(items: readonly ReviewItemPlacement[]) {
    return items.filter(
        (item): item is ReviewCommentPlacement => item.kind === "comment",
    );
}

/**
 * The public editor contract can add, reply to and delete comments but not
 * change their text, so an edit replaces the comment. That is only offered
 * where replacing is indistinguishable from editing: the signed-in author's
 * own comment with nothing after it in its thread (a root comment without
 * replies, or the last reply). Other people's dates and thread order are
 * never rewritten.
 */
export function docxCommentEditable(
    item: ReviewCommentPlacement,
    items: readonly ReviewItemPlacement[],
    author?: string,
) {
    if (!author?.trim() || item.author !== author || item.readOnly)
        return false;
    if (item.parentId) {
        const parent = commentsOf(items).find(
            (comment) => comment.id === item.parentId,
        );
        return !!parent && parent.replyIds.at(-1) === item.id;
    }
    const range = item.item.range;
    return (
        !item.parentRevisionId &&
        !item.item.orphaned &&
        item.replyIds.length === 0 &&
        range?.partName === BODY_PART
    );
}

/**
 * Replace an editable comment with new text, keeping its anchor, thread
 * position and resolved state. The replacement is written before the original
 * is removed, so a failure never loses the comment. Returns whether it applied.
 */
export function docxEditComment(
    editor: Editor,
    item: ReviewCommentPlacement,
    text: string,
    author: string,
) {
    const items = editor.getReviewItems();
    if (!docxCommentEditable(item, items, author)) return false;
    const before = new Set(items.map((entry) => entry.key));
    let added;
    if (item.parentId) {
        const parent = commentsOf(items).find(
            (comment) => comment.id === item.parentId,
        );
        if (!parent) return false;
        added = editor.replyToReviewItem(parent.key, text, author);
    } else {
        const range = item.item.range!;
        const selected = editor.exec({
            type: "setSelection",
            range: {
                anchor: {
                    paragraphId: range.start.paragraphId,
                    offset: range.start.offset,
                },
                head: {
                    paragraphId: range.end.paragraphId,
                    offset: range.end.offset,
                },
            },
        });
        if (!selected.ok) return false;
        added = editor.addComment(text, author);
    }
    if (!added.ok) return false;
    const replacement = commentsOf(editor.getReviewItems()).find(
        (entry) => !before.has(entry.key),
    );
    if (!replacement) return false;
    if (item.resolved && !item.parentId)
        editor.setCommentResolved(replacement.key, true);
    if (!editor.deleteReviewItem(item.key).ok) {
        editor.deleteReviewItem(replacement.key);
        return false;
    }
    return true;
}
