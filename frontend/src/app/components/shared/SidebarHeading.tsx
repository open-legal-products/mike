"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/app/lib/utils";

const HEADING_FONT_CLASS = "font-light font-serif";

/**
 * The name at the top of the sidebar: "Mike" for personal work, or the
 * active organization's name.
 *
 * Every name is set at the size "Mike" is, so switching workspace does not
 * change the look of the header. Only a name too long for one line at that
 * size drops to the smaller two-line setting, because the header row keeps a
 * fixed height. Whether it fits is measured rather than guessed from the
 * character count: in a proportional face "Illinois" and "WWWW" are nowhere
 * near the same width.
 */
export function SidebarHeading({
    name,
    className,
}: {
    name: string;
    className?: string;
}) {
    const containerRef = useRef<HTMLSpanElement>(null);
    const measureRef = useRef<HTMLSpanElement>(null);
    const [fits, setFits] = useState(true);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const measure = measureRef.current;
        if (!container || !measure) return;
        const update = () =>
            setFits(measure.offsetWidth <= container.clientWidth);
        // Before paint, so the name never appears at one size and jumps.
        update();
        // The sidebar animates open, so the room available changes after
        // the first measurement.
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(update);
        observer.observe(container);
        return () => observer.disconnect();
    }, [name]);

    return (
        // The wrapper takes whatever room the header row has left, whichever
        // size the name is set at, so it is a stable thing to measure against.
        <span ref={containerRef} className="relative flex min-w-0 flex-1">
            <span
                data-slot="sidebar-heading"
                data-size={fits ? "full" : "compact"}
                // Only a clamped name needs its full text somewhere else.
                title={fits ? undefined : name}
                className={cn(
                    "min-w-0",
                    HEADING_FONT_CLASS,
                    fits
                        ? "truncate text-xl"
                        : "line-clamp-2 break-words text-base leading-tight",
                    className,
                )}
            >
                {name}
            </span>
            {/* The name at full size on one line, out of flow and unseen:
                its width is what the room available is compared with. */}
            <span
                ref={measureRef}
                aria-hidden="true"
                className={cn(
                    "pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-xl",
                    HEADING_FONT_CLASS,
                )}
            >
                {name}
            </span>
        </span>
    );
}
