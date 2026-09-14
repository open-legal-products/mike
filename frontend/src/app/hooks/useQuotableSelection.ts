"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { normalizeExcerpt } from "@/app/lib/quotedExcerpts";

/**
 * Marker attribute a surface puts on the DOM subtree of a single assistant
 * response. Only text inside a marked element is quotable, which is what keeps
 * the "Add to Chat" popup out of the composer, out of user bubbles, and out of
 * every other selectable region of the page.
 */
export const QUOTABLE_ATTRIBUTE = "data-mike-quotable";
const QUOTABLE_SELECTOR = `[${QUOTABLE_ATTRIBUTE}]`;

export interface QuotableSelection {
    /** Normalized excerpt text, ready to attach as a chip. */
    text: string;
    /** Viewport-relative anchor rect of the highlighted range. */
    rect: { top: number; bottom: number; left: number; right: number };
}

function closestQuotable(node: Node | null): HTMLElement | null {
    const element =
        node === null
            ? null
            : node.nodeType === Node.ELEMENT_NODE
              ? (node as HTMLElement)
              : node.parentElement;
    return element?.closest?.(QUOTABLE_SELECTOR) ?? null;
}

/**
 * Clamp `range` to the contents of `bounds`. A drag that runs off the end of
 * one response and into the next (or into the page chrome) would otherwise
 * quote text the user cannot see in the chip — collapsing to the in-bubble
 * portion is both truthful and what the highlight visually suggested.
 */
function clampToElement(range: Range, bounds: HTMLElement): Range {
    const limits = bounds.ownerDocument.createRange();
    limits.selectNodeContents(bounds);
    const clamped = range.cloneRange();
    if (clamped.compareBoundaryPoints(Range.START_TO_START, limits) < 0) {
        clamped.setStart(limits.startContainer, limits.startOffset);
    }
    if (clamped.compareBoundaryPoints(Range.END_TO_END, limits) > 0) {
        clamped.setEnd(limits.endContainer, limits.endOffset);
    }
    limits.detach?.();
    return clamped;
}

function rectOf(range: Range): QuotableSelection["rect"] {
    // jsdom returns a zeroed rect; real browsers return the union of the
    // highlighted client rects. Either way the popup gets a usable anchor.
    const box = range.getBoundingClientRect?.();
    return {
        top: box?.top ?? 0,
        bottom: box?.bottom ?? 0,
        left: box?.left ?? 0,
        right: box?.right ?? 0,
    };
}

function readSelection(container: HTMLElement | null): QuotableSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0);
    // Anchor on the start of the drag: that is the response the user began
    // highlighting, and the one the excerpt should come from.
    const quotable = closestQuotable(range.startContainer);
    if (!quotable) return null;
    if (container && !container.contains(quotable)) return null;

    const clamped = clampToElement(range, quotable);
    const text = normalizeExcerpt(clamped.toString());
    if (text.length === 0) return null;
    return { text, rect: rectOf(clamped) };
}

/**
 * Watch for text selections inside assistant responses under `containerRef`.
 *
 * Returns the live selection (or null) plus a `clear` callback the caller uses
 * once it has consumed the excerpt. The selection is dropped as soon as the
 * user collapses it, scrolls, or presses Escape, so the floating popup never
 * outlives the highlight it points at.
 */
export function useQuotableSelection(
    containerRef: RefObject<HTMLElement | null>,
    options?: { enabled?: boolean },
): { selection: QuotableSelection | null; clear: () => void } {
    const enabled = options?.enabled ?? true;
    const [selection, setSelection] = useState<QuotableSelection | null>(null);
    // Suppresses re-detection of a selection the caller has already consumed,
    // until the user actually changes it.
    const dismissedRef = useRef(false);

    const clear = useCallback(() => {
        dismissedRef.current = true;
        setSelection(null);
    }, []);

    useEffect(() => {
        // Listeners are the only writers, so not subscribing is the whole of
        // "disabled"; the cleanup below drops any selection captured before
        // the surface turned the feature off.
        if (!enabled) return;

        const settle = () => {
            if (dismissedRef.current) return;
            setSelection(readSelection(containerRef.current));
        };

        const handleSelectionChange = () => {
            const current = window.getSelection();
            if (!current || current.isCollapsed) {
                // A plain click collapses the selection: that is our
                // click-away dismissal, and it re-arms detection.
                dismissedRef.current = false;
                setSelection(null);
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            // Shift+arrow extends a selection under caret browsing; other keys
            // are typing, which belongs to whatever field has focus.
            if (event.shiftKey) settle();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") clear();
        };

        const handleScroll = () => setSelection(null);

        document.addEventListener("mouseup", settle);
        document.addEventListener("keyup", handleKeyUp);
        document.addEventListener("keydown", handleKeyDown);
        document.addEventListener("selectionchange", handleSelectionChange);
        // Capture phase so scrolling any ancestor container counts, not just
        // the document — chat messages live in their own scroll region.
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("resize", handleScroll);
        return () => {
            document.removeEventListener("mouseup", settle);
            document.removeEventListener("keyup", handleKeyUp);
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener(
                "selectionchange",
                handleSelectionChange,
            );
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("resize", handleScroll);
            setSelection(null);
        };
    }, [clear, containerRef, enabled]);

    return { selection: enabled ? selection : null, clear };
}
