"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";

const HEADING_FONT_CLASS = "font-light font-serif";
/** The gap-1 between the name and anything trailing it. */
const TRAILING_GAP_PX = 4;

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
 *
 * Something `trailing` the name, such as a menu's chevron, sits right after
 * its last letter, and its width is part of the room the name needs.
 */
export function SidebarHeading({
    name,
    className,
    trailing,
}: {
    name: string;
    className?: string;
    trailing?: ReactNode;
}) {
    const containerRef = useRef<HTMLSpanElement>(null);
    const measureRef = useRef<HTMLSpanElement>(null);
    const trailingRef = useRef<HTMLSpanElement>(null);
    const hasTrailing = trailing != null;
    const [fits, setFits] = useState(true);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const measure = measureRef.current;
        if (!container || !measure) return;
        const update = () => {
            // Nothing trailing, or nothing laid out yet, needs no gap.
            const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
            const trailingRoom =
                trailingWidth > 0 ? trailingWidth + TRAILING_GAP_PX : 0;
            setFits(
                measure.offsetWidth + trailingRoom <= container.clientWidth,
            );
        };
        // Before paint, so the name never appears at one size and jumps.
        update();
        // The sidebar animates open, so the room available changes after
        // the first measurement.
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(update);
        observer.observe(container);
        return () => observer.disconnect();
    }, [name, hasTrailing]);

    return (
        // The wrapper takes whatever room the header row has left, whichever
        // size the name is set at, so it is a stable thing to measure against.
        <span
            ref={containerRef}
            className="relative flex min-w-0 flex-1 items-center gap-1"
        >
            <span
                data-slot="sidebar-heading"
                data-size={fits ? "full" : "compact"}
                // Only a clamped name needs its full text somewhere else.
                title={fits ? undefined : name}
                className={cn(
                    "min-w-0",
                    HEADING_FONT_CLASS,
                    fits
                        ? "truncate text-lg"
                        : "line-clamp-2 break-words text-sm leading-tight",
                    className,
                )}
            >
                {name}
            </span>
            {trailing ? (
                <span
                    ref={trailingRef}
                    data-slot="sidebar-heading-trailing"
                    className="flex shrink-0"
                >
                    {trailing}
                </span>
            ) : null}
            {/* The name at full size on one line, out of flow and unseen:
                its width is what the room available is compared with. */}
            <span
                ref={measureRef}
                aria-hidden="true"
                className={cn(
                    "pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-lg",
                    HEADING_FONT_CLASS,
                )}
            >
                {name}
            </span>
        </span>
    );
}
