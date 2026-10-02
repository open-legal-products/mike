"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MessageSquare, Pencil, Reply, Trash2, X } from "lucide-react";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { useEditorSnapshot } from "@docx-editor.dev/react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { docxCommentEditable } from "./docxCommentEditing";
import {
    docxCommentBandAt,
    docxHighlightedComment,
    docxReviewTarget,
} from "./docxReviewTarget";

export function DocxReviewActions({
    editor,
    surface,
    panel = null,
    author,
    onReply,
    onEdit,
    onView,
}: {
    editor: Editor;
    surface: HTMLElement;
    /** Comment column outside the page surface; its bubbles get the same menu. */
    panel?: HTMLElement | null;
    author?: string;
    onReply: (key: string) => void;
    onEdit?: (key: string) => void;
    /** Reveal a highlighted comment's bubble in the comments column. */
    onView?: (key: string) => void;
}) {
    useEditorSnapshot(editor);
    const pending = useRef<{
        action: "reply" | "edit" | "view";
        key: string;
    } | null>(null);
    const [menu, setMenu] = useState<{
        key: string;
        /** Comment highlights in the page offer View and Delete only. */
        highlight: boolean;
        x: number;
        y: number;
        target: HTMLElement;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let frame = 0;
        const open = (event: MouseEvent | KeyboardEvent) => {
            const keyboard = event instanceof KeyboardEvent;
            if (
                keyboard &&
                event.key !== "ContextMenu" &&
                !(event.shiftKey && event.key === "F10")
            )
                return;
            if (!(event.target instanceof Element)) return;
            let target = event.target;
            if (target.closest("textarea, input")) return;
            if (keyboard && target.matches('[contenteditable="true"]')) {
                const node = surface.ownerDocument.getSelection()?.anchorNode;
                const selected =
                    node instanceof Element ? node : node?.parentElement;
                if (selected && surface.contains(selected)) target = selected;
            }
            const rect = target.getBoundingClientRect();
            const x = keyboard ? rect.left : event.clientX;
            const y = keyboard ? rect.bottom : event.clientY;
            const show = (key: string, highlight: boolean) => {
                pending.current = null;
                setMenu({ key, highlight, target: target as HTMLElement, x, y });
            };
            const items = editor.getReviewItems();
            const direct = docxReviewTarget(target, items);
            const item =
                direct ??
                (keyboard
                    ? docxHighlightedComment(surface, items, null)
                    : undefined);
            if (item) {
                // Capture before the engine's normal context menu sees this event.
                event.preventDefault();
                event.stopPropagation();
                show(item.key, !direct);
                return;
            }
            const point = { x, y };
            if (keyboard || !docxCommentBandAt(surface, point)) return;
            event.preventDefault();
            event.stopPropagation();
            // The press moved the caret, but the engine marks the comment under
            // it active on a later frame. Wait briefly for that band to repaint.
            cancelAnimationFrame(frame);
            let attempts = 0;
            const resolve = () => {
                const comment = docxHighlightedComment(
                    surface,
                    editor.getReviewItems(),
                    point,
                );
                if (comment) show(comment.key, true);
                else if (++attempts < 10)
                    frame = requestAnimationFrame(resolve);
            };
            frame = requestAnimationFrame(resolve);
        };
        const roots = panel ? [surface, panel] : [surface];
        for (const root of roots) {
            root.addEventListener("contextmenu", open, true);
            root.addEventListener("keydown", open, true);
        }
        return () => {
            cancelAnimationFrame(frame);
            for (const root of roots) {
                root.removeEventListener("contextmenu", open, true);
                root.removeEventListener("keydown", open, true);
            }
        };
    }, [editor, surface, panel]);
    const item = menu
        ? editor.getReviewItems().find((entry) => entry.key === menu.key)
        : undefined;
    const snapshot = editor.snapshot();
    const disabled =
        !snapshot.editable ||
        snapshot.editingMode === "viewing" ||
        !item ||
        item.readOnly;
    const run = (action: "delete" | "accept" | "reject") => {
        if (!item || disabled) return;
        try {
            const result =
                action === "delete"
                    ? editor.deleteReviewItem(item.key)
                    : action === "accept"
                      ? editor.acceptReviewItem(item.key)
                      : editor.rejectReviewItem(item.key);
            if (!result.ok)
                setError("This action could not be applied. Please try again.");
        } catch {
            setError("This action could not be applied. Please try again.");
        }
    };
    return (
        <>
            <DropdownMenu
                open={!!menu && !!item}
                onOpenChange={(open) => {
                    if (!open) setMenu(null);
                }}
                modal={false}
            >
                {menu &&
                    createPortal(
                        <DropdownMenuTrigger asChild>
                            <span
                                aria-hidden="true"
                                tabIndex={-1}
                                className="pointer-events-none fixed h-0 w-0"
                                style={{ left: menu.x, top: menu.y }}
                            />
                        </DropdownMenuTrigger>,
                        surface.ownerDocument.body,
                    )}
                <LiquidDropdownContent
                    align="start"
                    sideOffset={0}
                    className="z-[250] w-48"
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        if (pending.current) {
                            const { action, key } = pending.current;
                            pending.current = null;
                            if (action === "edit") onEdit?.(key);
                            else if (action === "view") onView?.(key);
                            else onReply(key);
                        } else if (menu?.target.isConnected) {
                            menu.target.focus({ preventScroll: true });
                        }
                    }}
                >
                    {item?.kind === "comment" && menu?.highlight ? (
                        <>
                            <LiquidDropdownItem
                                disabled={!onView}
                                onSelect={() => {
                                    pending.current = {
                                        action: "view",
                                        key: item.key,
                                    };
                                    setMenu(null);
                                }}
                            >
                                <MessageSquare className="h-3.5 w-3.5" />
                                View comment
                            </LiquidDropdownItem>
                            <LiquidDropdownItem
                                disabled={disabled}
                                variant="destructive"
                                onSelect={() => run("delete")}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete comment
                            </LiquidDropdownItem>
                        </>
                    ) : item?.kind === "comment" ? (
                        <>
                            <LiquidDropdownItem
                                disabled={disabled || !author?.trim()}
                                onSelect={() => {
                                    pending.current = {
                                        action: "reply",
                                        key: item.key,
                                    };
                                    setMenu(null);
                                }}
                            >
                                <Reply className="h-3.5 w-3.5" />
                                Reply to comment
                            </LiquidDropdownItem>
                            {onEdit && (
                                <LiquidDropdownItem
                                    disabled={
                                        disabled ||
                                        !docxCommentEditable(
                                            item,
                                            editor.getReviewItems(),
                                            author,
                                        )
                                    }
                                    onSelect={() => {
                                        pending.current = {
                                            action: "edit",
                                            key: item.key,
                                        };
                                        setMenu(null);
                                    }}
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Edit comment
                                </LiquidDropdownItem>
                            )}
                            <LiquidDropdownItem
                                disabled={disabled}
                                variant="destructive"
                                onSelect={() => run("delete")}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete comment
                            </LiquidDropdownItem>
                        </>
                    ) : (
                        <>
                            <LiquidDropdownItem
                                disabled={disabled}
                                onSelect={() => run("accept")}
                            >
                                <Check className="h-3.5 w-3.5" />
                                Accept tracked change
                            </LiquidDropdownItem>
                            <LiquidDropdownItem
                                disabled={disabled}
                                onSelect={() => run("reject")}
                            >
                                <X className="h-3.5 w-3.5" />
                                Reject tracked change
                            </LiquidDropdownItem>
                        </>
                    )}
                </LiquidDropdownContent>
            </DropdownMenu>
            <WarningPopup
                open={!!error}
                title="Unable to update document"
                message={error}
                onClose={() => setError(null)}
            />
        </>
    );
}
