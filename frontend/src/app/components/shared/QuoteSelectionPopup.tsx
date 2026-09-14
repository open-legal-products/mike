"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { MessageSquareQuote, Sparkles } from "lucide-react";
import type { QuotableSelection } from "@/app/hooks/useQuotableSelection";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

/** Gap between the highlighted text and the popup, in pixels. */
const ANCHOR_GAP = 8;
/**
 * Width used to keep the popup inside the viewport. It widens when the second
 * action is offered, so a highlight near the right edge still gets a popup that
 * is fully visible.
 */
const ESTIMATED_WIDTH = 132;
const ESTIMATED_WIDTH_WITH_ASSIGN = 272;
const ESTIMATED_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;

/**
 * Place the popup just above the middle of the highlight, flipping below it
 * when there is no room, and keeping it inside the viewport on both axes.
 * Coordinates are viewport-relative because the popup is `position: fixed` in
 * a body portal — a chat transcript lives inside an `overflow` scroller that
 * would otherwise clip it.
 */
export function popupPosition(
    rect: QuotableSelection["rect"],
    viewport: { width: number; height: number },
    options?: { width?: number },
): { top: number; left: number } {
    const width = options?.width ?? ESTIMATED_WIDTH;
    const above = rect.top - ESTIMATED_HEIGHT - ANCHOR_GAP;
    const top =
        above >= VIEWPORT_MARGIN ? above : rect.bottom + ANCHOR_GAP;
    const centered = (rect.left + rect.right) / 2 - width / 2;
    const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        viewport.width - width - VIEWPORT_MARGIN,
    );
    return {
        top: Math.min(
            Math.max(VIEWPORT_MARGIN, top),
            Math.max(
                VIEWPORT_MARGIN,
                viewport.height - ESTIMATED_HEIGHT - VIEWPORT_MARGIN,
            ),
        ),
        left: Math.min(Math.max(VIEWPORT_MARGIN, centered), maxLeft),
    };
}

interface Props {
    selection: QuotableSelection | null;
    onAdd: (text: string) => void;
    /**
     * Offered only where an agent can actually be assigned — the standalone
     * and project assistant chats. Omitting it leaves the popup exactly as it
     * was, which is what the tabular-review chat wants.
     */
    onAssign?: (text: string) => void;
    /** Set when the response already carries the maximum number of agents. */
    assignDisabledReason?: string | null;
}

const ACTION_CLASS = cn(
    "flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs text-gray-700 transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed disabled:opacity-50",
);

/**
 * The popup that appears beside a highlight inside an assistant response.
 *
 * "Add to Chat" attaches the excerpt to the composer as a quoted-context chip.
 * "Assign to agent" hands the same excerpt to a side panel that will spawn a
 * concurrent agent for it. Enter is bound to Add to Chat only — it is the
 * non-destructive one, and assigning deserves the deliberate click that opens
 * the instruction field.
 */
export function QuoteSelectionPopup({
    selection,
    onAdd,
    onAssign,
    assignDisabledReason,
}: Props) {
    useEffect(() => {
        if (!selection) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            const target = event.target as HTMLElement | null;
            // Never steal Enter from the composer or any other text entry —
            // there the key means "send", and the popup is incidental.
            if (
                target?.closest?.(
                    "input, textarea, select, [contenteditable='true']",
                )
            ) {
                return;
            }
            event.preventDefault();
            onAdd(selection.text);
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onAdd, selection]);

    if (!selection || typeof document === "undefined") return null;

    const { top, left } = popupPosition(
        selection.rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: onAssign ? ESTIMATED_WIDTH_WITH_ASSIGN : undefined },
    );

    return createPortal(
        <div
            className={cn(
                "fixed z-50 flex items-center gap-1 rounded-full p-0.5",
                LIQUID_GLASS_FLOAT_CLASS,
            )}
            style={{ top, left }}
            // The popup sits over live text; a mousedown here would collapse
            // the selection before the click handler could read it.
            onMouseDown={(event) => event.preventDefault()}
        >
            <button
                type="button"
                onClick={() => onAdd(selection.text)}
                className={cn(ACTION_CLASS, LIQUID_GLASS_HOVER_CLASS)}
            >
                <MessageSquareQuote
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden
                />
                Add to Chat
            </button>
            {onAssign && (
                <button
                    type="button"
                    onClick={() => onAssign(selection.text)}
                    disabled={!!assignDisabledReason}
                    title={assignDisabledReason ?? undefined}
                    className={cn(ACTION_CLASS, LIQUID_GLASS_HOVER_CLASS)}
                >
                    <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Assign to agent
                </button>
            )}
        </div>,
        document.body,
    );
}
