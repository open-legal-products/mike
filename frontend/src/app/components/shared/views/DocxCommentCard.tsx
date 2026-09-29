"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";

import { useRef, useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type {
    Editor,
    ReviewCommentPlacement,
} from "@docx-editor.dev/core/contracts/editor";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { LIQUID_FLOAT_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { DocxCommentEdit } from "./DocxCommentEdit";
import { DocxCommentReply } from "./DocxCommentReply";
import { docxCommentEditable } from "./docxCommentEditing";

/** One thread: the root comment, its replies, and a reply action. */
export function DocxCommentCard({
    editor,
    thread,
    replies,
    items,
    author,
    replyKey,
    editKey,
    onReply,
    onReplyClose,
    onEdit,
    onEditClose,
}: {
    editor: Editor;
    thread: ReviewCommentPlacement;
    replies: readonly ReviewCommentPlacement[];
    items: readonly ReviewCommentPlacement[];
    author?: string;
    replyKey: string | null;
    editKey: string | null;
    onReply: (key: string) => void;
    onReplyClose: () => void;
    onEdit: (key: string) => void;
    onEditClose: () => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const snapshot = editor.snapshot();
    const writable = snapshot.editable && snapshot.editingMode !== "viewing";
    const entries = [thread, ...replies];
    const replying = replyKey !== null && entries.some((entry) => entry.key === replyKey);
    const reveal = () => {
        if (!thread.activatable) return;
        const result = editor.setActiveReviewItem(thread.key);
        setError(
            result.ok ? null : "This comment could not be shown in the document.",
        );
    };
    const remove = (entry: ReviewCommentPlacement) => {
        try {
            const result = editor.deleteReviewItem(entry.key);
            setError(
                result.ok
                    ? null
                    : "This comment could not be deleted. Please try again.",
            );
        } catch {
            setError("This comment could not be deleted. Please try again.");
        }
    };
    return (
        <section
            data-comment-key={thread.key}
            data-active={thread.isActive || undefined}
            tabIndex={0}
            aria-label={`Comment by ${thread.author || "Unknown author"}`}
            className={`w-[var(--mike-docx-comment-width)] p-3 focus-visible:outline-2 focus-visible:outline-ring ${thread.activatable ? "cursor-pointer" : ""} ${LIQUID_FLOAT_PANEL_SURFACE_CLASS} ${thread.isActive ? "ring-1 ring-ring/30" : ""}`}
            onClick={(event) => {
                // Controls and forms inside the card keep their own behavior,
                // and selecting card text to copy it must not jump the page.
                if (
                    event.target instanceof Element &&
                    event.target.closest("button, textarea, input, form, [role='menu']")
                )
                    return;
                if (window.getSelection()?.toString()) return;
                reveal();
            }}
            onKeyDown={(event) => {
                if (event.target === event.currentTarget && event.key === "Enter") {
                    event.preventDefault();
                    reveal();
                }
            }}
        >
            {entries.map((entry, index) => (
                <div
                    key={entry.key}
                    data-comment-key={index === 0 ? undefined : entry.key}
                    tabIndex={index === 0 ? undefined : 0}
                    className={
                        index === 0
                            ? "space-y-1"
                            : "-mx-3 mt-3 space-y-1 border-t border-border px-3 pt-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    }
                >
                    <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate font-medium">
                            {entry.author || "Unknown author"}
                        </p>
                        <CommentMenu
                            label={`Actions for ${index === 0 ? "comment" : "reply"} by ${entry.author || "Unknown author"}`}
                            canEdit={
                                writable &&
                                docxCommentEditable(entry, items, author)
                            }
                            canDelete={writable && !entry.readOnly}
                            onEdit={() => onEdit(entry.key)}
                            onDelete={() => remove(entry)}
                        />
                    </div>
                    {editKey === entry.key ? (
                        <DocxCommentEdit
                            key={entry.key}
                            editor={editor}
                            comment={entry}
                            author={author}
                            onClose={onEditClose}
                        />
                    ) : (
                        <>
                            <p className="whitespace-pre-wrap break-words">
                                {entry.text ||
                                    (index === 0 ? "Empty comment" : "")}
                            </p>
                            <CommentTime date={entry.date} />
                        </>
                    )}
                </div>
            ))}
            {thread.resolved && (
                <p className="mt-2 text-muted-foreground">Resolved</p>
            )}
            {replying ? (
                <DocxCommentReply
                    key={replyKey}
                    editor={editor}
                    commentKey={replyKey}
                    author={author}
                    onClose={onReplyClose}
                />
            ) : (
                <TextButtonUI
                    size="xs"
                    className="mt-2 -ml-1.5"
                    disabled={!writable || !author?.trim() || thread.readOnly}
                    onClick={() => onReply(thread.key)}
                >
                    Reply
                </TextButtonUI>
            )}
            {error && (
                <p role="alert" className="mt-2 text-destructive">
                    {error}
                </p>
            )}
        </section>
    );
}

/** Word omits `@w:date` when date stamping is off; show nothing then. */
function CommentTime({ date }: { date?: string }) {
    const time = date ? new Date(date) : null;
    if (!time || Number.isNaN(time.getTime())) return null;
    return (
        <time dateTime={date} className="block text-[11px] text-muted-foreground">
            {time.toLocaleString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
            })}
        </time>
    );
}

function CommentMenu({
    label,
    canEdit,
    canDelete,
    onEdit,
    onDelete,
}: {
    label: string;
    canEdit: boolean;
    canDelete: boolean;
    onEdit: () => void;
    onDelete: () => void;
}) {
    // Opening the editor must not lose focus back to the trigger on close.
    const editing = useRef(false);
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <TextButtonUI
                    size="icon-xs"
                    aria-label={label}
                    title="More actions"
                    className="-mr-1 flex-none"
                >
                    <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                </TextButtonUI>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="end"
                className="z-[250] w-36"
                onCloseAutoFocus={(event) => {
                    if (!editing.current) return;
                    editing.current = false;
                    event.preventDefault();
                    onEdit();
                }}
            >
                <LiquidDropdownItem
                    disabled={!canEdit}
                    onSelect={() => {
                        editing.current = true;
                    }}
                >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                </LiquidDropdownItem>
                <LiquidDropdownItem
                    disabled={!canDelete}
                    variant="destructive"
                    onSelect={onDelete}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                </LiquidDropdownItem>
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
