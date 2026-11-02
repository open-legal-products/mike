import { useEffect, useRef, useState } from "react";

/** Disclosure behavior shared by web and Word reasoning blocks. */
export function useReasoningDisclosure(isStreaming: boolean) {
    // Follow stream status until the user explicitly chooses a disclosure state.
    // Derive this default: syncing it in an effect on every text chunk can
    // enqueue passive updates even when React receives the same boolean.
    const [openOverride, setOpenOverride] = useState<boolean | null>(null);
    const isContentOpen = openOverride ?? isStreaming;
    const [isExpanded, setIsExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const overflowingRef = useRef(false);
    const contentRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const element = contentRef.current;
        if (!isContentOpen || !element) return;

        let frame: number | null = null;
        let disposed = false;
        const measure = () => {
            frame = null;
            if (disposed) return;
            const lineHeight =
                parseFloat(getComputedStyle(element).lineHeight) || 24;
            const next = element.scrollHeight > lineHeight * 6 + 2;
            // Guard before dispatch, rather than relying on a setState bailout
            // while concurrent streaming work may already be queued.
            if (next === overflowingRef.current) return;
            overflowingRef.current = next;
            setIsOverflowing(next);
            if (!next) setIsExpanded(false);
        };
        const scheduleMeasure = () => {
            if (!disposed && frame === null) {
                frame = requestAnimationFrame(measure);
            }
        };

        scheduleMeasure();
        // Observe the natural content, not its clipped wrapper. This covers
        // streamed text, width changes and font loading without text effects.
        const observer = new ResizeObserver(scheduleMeasure);
        observer.observe(element);
        return () => {
            disposed = true;
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [isContentOpen]);

    return {
        contentRef,
        isContentOpen,
        isExpanded,
        isOverflowing,
        setIsExpanded,
        toggleContent: () =>
            setOpenOverride((previous) => !(previous ?? isStreaming)),
    };
}
