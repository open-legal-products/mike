"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Copy, MessageSquare, TextQuote } from "lucide-react";
import { DropdownAtPoint, DropdownItem, DropdownSurface } from "./dropdown";
import { COMPOSER_SEND_BUTTON_CLASS } from "./ComposerSendButtonUI.styles";
import {
    normalizeExcerptNote,
    normalizeExcerptText,
    type MessageExcerpt,
} from "../lib/messageExcerpts";

/** Marks the response text a reader can highlight to quote or annotate. */
export const EXCERPT_SOURCE_PROPS = { "data-excerpt-source": "" } as const;

const EXCERPT_SOURCE_SELECTOR = "[data-excerpt-source]";
const OWN_UI_SELECTOR = '[data-slot="dropdown-content"], [data-excerpt-bubble]';
const HIGHLIGHT_NAME = "response-excerpt";
const BUBBLE_WIDTH_PX = 320;
const BUBBLE_HEIGHT_PX = 44;
const VIEWPORT_MARGIN_PX = 8;

type Point = { x: number; y: number };
type SelectedExcerpt = { text: string; point: Point; range: Range };

function excerptSourceOf(node: Node | null): Element | null {
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest(EXCERPT_SOURCE_SELECTOR) ?? null;
}

/**
 * Whether all the selected text sits in the one response block the selection
 * starts in. The end of the range may still fall outside it: selecting a whole
 * paragraph (a triple-click) ends at the start of whatever follows. A
 * selection that runs on into other content is not a passage of the response.
 */
function selectsWithinOneSource(range: Range): boolean {
    const source = excerptSourceOf(range.startContainer);
    if (!source) return false;
    if (source.contains(range.endContainer)) return true;
    const overflow = range.cloneRange();
    overflow.setStartAfter(source);
    return overflow.toString().trim() === "";
}

function readSelectedExcerpt(
    pointer: Point | null,
    scope: Element | null,
): SelectedExcerpt | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0).cloneRange();
    if (!selectsWithinOneSource(range)) return null;
    if (scope && !scope.contains(range.startContainer)) return null;
    const text = normalizeExcerptText(selection.toString());
    if (!text) return null;
    return {
        text,
        range,
        point: endOfRange(range) ?? pointer ?? { x: 0, y: 0 },
    };
}

/**
 * Just below where the highlighted text ends, so the menu follows the passage
 * rather than wherever the pointer happened to be released.
 */
function endOfRange(range: Range): Point | null {
    if (typeof range.getClientRects !== "function") return null;
    // A selection that stops at a line or block boundary ends in empty rects.
    const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
    );
    const last = rects[rects.length - 1];
    return last ? { x: last.right, y: last.bottom + 6 } : null;
}

type HighlightRegistry = {
    set: (name: string, highlight: unknown) => void;
    delete: (name: string) => void;
    Highlight: new (...ranges: Range[]) => unknown;
};

/** The CSS Custom Highlight API, or null where the browser lacks it. */
function highlightRegistry(): HighlightRegistry | null {
    const registry = (
        globalThis.CSS as
            | { highlights?: Omit<HighlightRegistry, "Highlight"> }
            | undefined
    )?.highlights;
    const Highlight = (globalThis as { Highlight?: HighlightRegistry["Highlight"] })
        .Highlight;
    if (!registry || !Highlight) return null;
    return {
        set: (name, highlight) => registry.set(name, highlight),
        delete: (name) => registry.delete(name),
        Highlight,
    };
}

/**
 * Keeps the passage visibly marked while its menu or note is open: focus
 * moving into either takes the browser's own selection highlight away.
 * Browsers without the CSS Custom Highlight API simply show no mark.
 *
 * When the passage is let go (an action ran, or the menu or note was
 * dismissed) nothing may stay highlighted, so the selection goes with the mark.
 */
function useRangeHighlight(range: Range | null) {
    useEffect(() => {
        if (!range) return;
        const registry = highlightRegistry();
        registry?.set(HIGHLIGHT_NAME, new registry.Highlight(range));
        return () => {
            registry?.delete(HIGHLIGHT_NAME);
            releaseSelection(range);
        };
    }, [range]);
}

/**
 * Drops the browser selection if it is still this passage, leaving a newer
 * selection alone. A selection change is also what makes every engine repaint
 * the passage, which removing a custom highlight alone does not guarantee.
 */
function releaseSelection(range: Range) {
    const selection = window.getSelection();
    if (!selection) return;
    if (selection.rangeCount > 0 && !selection.isCollapsed) {
        const current = selection.getRangeAt(0);
        const same =
            current.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
            current.compareBoundaryPoints(Range.END_TO_END, range) === 0;
        if (!same) return;
    } else if (range.collapsed || !range.startContainer.isConnected) {
        return;
    } else {
        selection.removeAllRanges();
        selection.addRange(range);
    }
    selection.removeAllRanges();
}

/**
 * Calls `onChange` whenever the passage in `range` may have moved on screen:
 * the window resized, something scrolled, or its column reflowed without the
 * window changing size (a side panel opening). A resize event can arrive
 * before the new layout does; the observer reports once it has.
 */
function useLayoutChange(range: Range | null, onChange: () => void) {
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    });
    useEffect(() => {
        if (!range) return;
        const notify = () => onChangeRef.current();
        window.addEventListener("resize", notify);
        document.addEventListener("scroll", notify, true);
        const container = range.commonAncestorContainer;
        const passage =
            container instanceof Element ? container : container.parentElement;
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(notify);
        observer?.observe(document.documentElement);
        if (passage) observer?.observe(passage);
        return () => {
            window.removeEventListener("resize", notify);
            document.removeEventListener("scroll", notify, true);
            observer?.disconnect();
        };
    }, [range]);
}

/** Below the end of the passage, pulled in from any viewport edge. */
function placeBubble(range: Range, fallback: Point) {
    const anchor = endOfRange(range) ?? fallback;
    const clamp = (value: number, size: number, extent: number) =>
        Math.max(
            VIEWPORT_MARGIN_PX,
            Math.min(value, extent - size - VIEWPORT_MARGIN_PX),
        );
    return {
        left: clamp(anchor.x, BUBBLE_WIDTH_PX, window.innerWidth),
        top: clamp(anchor.y, BUBBLE_HEIGHT_PX, window.innerHeight),
    };
}

function AnnotationBubble({
    point,
    range,
    onSubmit,
    onClose,
}: {
    /** Where the passage ended when it was highlighted. */
    point: Point;
    /** The passage itself, so the bubble can follow it as the page reflows. */
    range: Range;
    onSubmit: (note: string) => void;
    onClose: () => void;
}) {
    const [note, setNote] = useState("");
    const surfaceRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // After the menu that opened this has finished handing focus back.
        const frame = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    useEffect(() => {
        const closeOnOutsidePress = (event: PointerEvent) => {
            if (!surfaceRef.current?.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", closeOnOutsidePress);
        return () =>
            document.removeEventListener("pointerdown", closeOnOutsidePress);
    }, [onClose]);

    // Resizing the window or scrolling the thread moves the passage and the
    // viewport edges, so place the bubble again each time, as a menu would.
    // Held in state and measured in the handlers: a position derived during
    // render would be cached against `range`, which never changes identity.
    const [{ left, top }, setPlacement] = useState(() =>
        placeBubble(range, point),
    );
    useLayoutChange(range, () => setPlacement(placeBubble(range, point)));

    const trimmed = normalizeExcerptNote(note);

    return createPortal(
        <DropdownSurface
            ref={surfaceRef}
            data-excerpt-bubble=""
            style={{ position: "fixed", left, top, width: BUBBLE_WIDTH_PX }}
            className="max-w-[calc(100vw-1rem)] rounded-full"
        >
            <form
                className="flex items-center gap-2 py-1.5 pl-4 pr-1.5"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (trimmed) onSubmit(trimmed);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <input
                    ref={inputRef}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    aria-label="Note about the selected text"
                    // Sits on the surface's glass with no fill of its own.
                    data-dropdown-input="flush"
                    placeholder="Add a note about this passage"
                    className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
                />
                <button
                    type="submit"
                    aria-label="Add annotation to chat"
                    disabled={!trimmed}
                    className={`${COMPOSER_SEND_BUTTON_CLASS} h-7 w-7 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60`}
                >
                    <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
            </form>
        </DropdownSurface>,
        document.body,
    );
}

/**
 * The menu a reader gets for text they highlight in an assistant response:
 * copy it, quote it in the composer, or quote it with a note attached.
 * Mount it once beside the thread; it watches every element spread with
 * `EXCERPT_SOURCE_PROPS`.
 */
export function ResponseSelectionMenuUI({
    canAsk = true,
    onAddExcerpt,
    scopeRef,
}: {
    /** False leaves only Copy, for a reader who cannot send to this chat. */
    canAsk?: boolean;
    onAddExcerpt: (excerpt: MessageExcerpt) => void;
    /**
     * Limits the menu to responses inside this element. Pass it wherever two
     * threads share a page, so a passage is quoted into its own composer.
     */
    scopeRef?: RefObject<Element | null>;
}) {
    const [menu, setMenu] = useState<SelectedExcerpt | null>(null);
    const [annotating, setAnnotating] = useState<SelectedExcerpt | null>(null);
    useRangeHighlight(annotating?.range ?? menu?.range ?? null);

    // WebKit (Safari, and Word's task pane on a Mac) clears the selection the
    // moment focus moves into the menu. The mark above keeps the passage
    // highlighted there; only a browser that cannot draw the mark gets its
    // selection put back instead. Doing both would paint the passage twice,
    // and WebKit darkens a selection drawn over the mark.
    const menuRange = menu?.range ?? null;
    useEffect(() => {
        if (!menuRange || highlightRegistry()) return;
        const frame = requestAnimationFrame(() => {
            const selection = window.getSelection();
            if (!selection || !selection.isCollapsed) return;
            selection.removeAllRanges();
            selection.addRange(menuRange);
        });
        return () => cancelAnimationFrame(frame);
    }, [menuRange]);
    // The menu stays under the end of the passage as it moves, like the note.
    useLayoutChange(menu?.range ?? null, () =>
        setMenu((current) => {
            const point = current && endOfRange(current.range);
            if (!current || !point) return current;
            return point.x === current.point.x && point.y === current.point.y
                ? current
                : { ...current, point };
        }),
    );

    useEffect(() => {
        let timer: number | null = null;
        const openForSelection = (event: Event, pointer: Point | null) => {
            const target = event.target;
            if (target instanceof Element && target.closest(OWN_UI_SELECTOR)) {
                return;
            }
            // A click inside an existing selection only collapses it after
            // this event, so read the selection once the browser has settled.
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                const selected = readSelectedExcerpt(
                    pointer,
                    scopeRef?.current ?? null,
                );
                if (selected) setMenu(selected);
            }, 0);
        };
        const onMouseUp = (event: MouseEvent) =>
            openForSelection(event, { x: event.clientX, y: event.clientY });
        const onKeyUp = (event: KeyboardEvent) => {
            // Shift+arrow selection; other keys do not change what is selected.
            if (event.key === "Shift") openForSelection(event, null);
        };
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("keyup", onKeyUp);
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            document.removeEventListener("mouseup", onMouseUp);
            document.removeEventListener("keyup", onKeyUp);
        };
    }, [scopeRef]);

    return (
        <>
            {menu && (
                <DropdownAtPoint
                    point={menu.point}
                    followPoint
                    onClose={() => setMenu(null)}
                    aria-label="Selected text"
                    className="w-44"
                >
                    <DropdownItem
                        onSelect={() => {
                            void navigator.clipboard
                                ?.writeText(menu.text)
                                .catch(() => undefined);
                        }}
                    >
                        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                        Copy
                    </DropdownItem>
                    {canAsk && (
                        <>
                            <DropdownItem
                                onSelect={() => {
                                    onAddExcerpt({ text: menu.text });
                                }}
                            >
                                <TextQuote
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5"
                                />
                                Ask
                            </DropdownItem>
                            <DropdownItem onSelect={() => setAnnotating(menu)}>
                                <MessageSquare
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5"
                                />
                                Annotate and ask
                            </DropdownItem>
                        </>
                    )}
                </DropdownAtPoint>
            )}
            {annotating && (
                <AnnotationBubble
                    point={annotating.point}
                    range={annotating.range}
                    onClose={() => setAnnotating(null)}
                    onSubmit={(note) => {
                        onAddExcerpt({ text: annotating.text, note });
                        setAnnotating(null);
                    }}
                />
            )}
        </>
    );
}
