"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";

import {
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import type {
    Editor,
    ReviewCommentPlacement,
} from "@docx-editor.dev/core/contracts/editor";
import {
    ReviewRailContext,
    useEditorSnapshot,
    useEditorState,
} from "@docx-editor.dev/react";
import { X } from "lucide-react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { DocxCommentComposer } from "./DocxCommentComposer";
import { DocxReviewActions } from "./DocxReviewActions";
import { DocxCommentCard } from "./DocxCommentCard";
import { openReviewPane, useRequestedReviewPane } from "./docxReviewPane";

/** Host-owned comment column, docked beside the editor viewport like its navigation pane. */
export function DocxReviewPanel({
    editor,
    author,
    toolbar = null,
    surface = null,
    rail = null,
}: {
    editor: Editor | null;
    author?: string;
    toolbar?: HTMLElement | null;
    surface?: HTMLElement | null;
    /** Flex row holding the viewport; the column is appended after it. */
    rail?: HTMLElement | null;
}) {
    const [column, setColumn] = useState<HTMLElement | null>(null);
    useEditorSnapshot(editor);
    // Toggling the pane is a state tick, not a document or selection change,
    // so useEditorSnapshot alone never re-renders for the Comments button.
    useEditorState((snapshot) => snapshot.reviewPaneOpen);
    const [replyKey, setReplyKey] = useState<string | null>(null);
    const [editKey, setEditKey] = useState<string | null>(null);
    // A fresh object per request so viewing the same comment twice re-reveals it.
    const [viewRequest, setViewRequest] = useState<{ key: string } | null>(
        null,
    );
    const registry = useContext(ReviewRailContext);
    const register = useRef(registry?.register);
    const open = useRequestedReviewPane(editor);
    // Registration tells the native viewport to reserve room beside the page.
    // Capture the registration function once: the registry value changes its
    // identity when its mounted count changes.
    useEffect(() => (open ? register.current?.() : undefined), [open]);
    if (!editor) return null;
    // Replies and edits are written in the thread's bubble.
    const inBubble = (start: () => void) => {
        openReviewPane(editor);
        start();
    };
    const startReply = (key: string) => {
        setEditKey(null);
        setReplyKey(key);
    };
    const startEdit = (key: string) => {
        setReplyKey(null);
        setEditKey(key);
    };
    const items = editor
        .getReviewItems()
        .filter(
            (item): item is ReviewCommentPlacement => item.kind === "comment",
        );
    return (
        <>
            <DocxCommentComposer
                editor={editor}
                author={author}
                toolbar={toolbar}
                surface={surface}
            />
            {surface && (
                <DocxReviewActions
                    editor={editor}
                    surface={surface}
                    panel={column}
                    author={author}
                    onReply={(key) => inBubble(() => startReply(key))}
                    onEdit={(key) => inBubble(() => startEdit(key))}
                    onView={(key) => inBubble(() => setViewRequest({ key }))}
                />
            )}
            {open &&
                rail &&
                createPortal(
                    <CommentColumn
                        ref={setColumn}
                        editor={editor}
                        items={items}
                        author={author}
                        replyKey={replyKey}
                        editKey={editKey}
                        viewRequest={viewRequest}
                        onReply={startReply}
                        onReplyClose={() => setReplyKey(null)}
                        onEdit={startEdit}
                        onEditClose={() => setEditKey(null)}
                    />,
                    rail,
                )}
        </>
    );
}

function CommentColumn({
    ref,
    editor,
    items,
    author,
    replyKey,
    editKey,
    viewRequest,
    onReply,
    onReplyClose,
    onEdit,
    onEditClose,
}: {
    ref: (element: HTMLElement | null) => void;
    editor: Editor;
    items: readonly ReviewCommentPlacement[];
    author?: string;
    replyKey: string | null;
    editKey: string | null;
    viewRequest: { key: string } | null;
    onReply: (key: string) => void;
    onReplyClose: () => void;
    onEdit: (key: string) => void;
    onEditClose: () => void;
}) {
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const original = editor.snapshot().zoomMode;
        if (original?.type !== "fit") return;
        // Keep the page usable beside the column in a narrow panel; let the
        // page scroll horizontally once there is too little room for both.
        const withCards = {
            ...original,
            minZoom: Math.min(
                original.maxZoom ?? 1,
                Math.max(original.minZoom ?? 0.1, 0.4),
            ),
        };
        editor.setZoomMode(withCards);
        return () => {
            // Preserve a manual zoom chosen while the column was visible.
            if (
                JSON.stringify(editor.snapshot().zoomMode) ===
                JSON.stringify(withCards)
            )
                editor.setZoomMode(original);
        };
    }, [editor]);
    // Replies stay in their parent thread, not separate bubbles.
    const byId = new Map(items.map((item) => [item.id, item]));
    const rootKey = (item: ReviewCommentPlacement) => {
        const visited = new Set<string>();
        while (
            item.parentId &&
            byId.has(item.parentId) &&
            !visited.has(item.key)
        ) {
            visited.add(item.key);
            item = byId.get(item.parentId)!;
        }
        return item.key;
    };
    const threads = items
        .filter((item) => rootKey(item) === item.key)
        .sort((a, b) => (a.anchorY ?? Infinity) - (b.anchorY ?? Infinity));
    const active = items.find((item) => item.isActive);
    const activeThread = active ? rootKey(active) : undefined;
    useEffect(() => {
        // Follow selection in the document without moving the page itself.
        if (!activeThread) return;
        list.current
            ?.querySelector<HTMLElement>(
                `:scope > [data-comment-key="${CSS.escape(activeThread)}"]`,
            )
            ?.scrollIntoView?.({ block: "nearest" });
    }, [activeThread]);
    useEffect(() => {
        // "View comment" from a highlight: reveal and focus its bubble.
        if (!viewRequest) return;
        // Opening the pane relayouts the page and the engine then refocuses
        // its surface; reveal the bubble once that has settled.
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                const bubble = list.current?.querySelector<HTMLElement>(
                    `[data-comment-key="${CSS.escape(viewRequest.key)}"]`,
                );
                bubble?.scrollIntoView?.({ block: "nearest" });
                bubble?.focus({ preventScroll: true });
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [viewRequest]);
    return (
        <aside
            ref={ref}
            aria-label="Document comments"
            className="flex min-h-0 w-[calc(var(--mike-docx-comment-width)+24px)] flex-none flex-col text-xs text-foreground"
            onKeyDown={(event) => {
                event.stopPropagation();
                // Escape in a portaled card menu closes only that menu.
                if (
                    event.key === "Escape" &&
                    event.currentTarget.contains(event.target as Node)
                )
                    editor.exec({ type: "toggleReviewPane" });
            }}
        >
            <div className="flex flex-none items-center justify-between py-3 pr-2 pl-3">
                <h2 className="text-sm font-medium">Comments</h2>
                <TextButtonUI
                    size="icon-xs"
                    aria-label="Close comments"
                    title="Close comments"
                    onClick={() => editor.exec({ type: "toggleReviewPane" })}
                >
                    <X aria-hidden="true" className="h-4 w-4" />
                </TextButtonUI>
            </div>
            <div
                ref={list}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3"
            >
                {items.length === 0 && (
                    <p className="py-3 text-muted-foreground">No comments.</p>
                )}
                {threads.map((item) => (
                    <DocxCommentCard
                        key={item.key}
                        editor={editor}
                        thread={item}
                        replies={items.filter(
                            (reply) =>
                                reply.key !== item.key &&
                                rootKey(reply) === item.key,
                        )}
                        items={items}
                        author={author}
                        replyKey={replyKey}
                        editKey={editKey}
                        onReply={onReply}
                        onReplyClose={onReplyClose}
                        onEdit={onEdit}
                        onEditClose={onEditClose}
                    />
                ))}
            </div>
        </aside>
    );
}
