"use client";

import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type TextSlabUIProps = Omit<
    HTMLAttributes<HTMLDivElement>,
    "children" | "className"
> & {
    children: ReactNode;
    className?: string;
    /** Swaps the resting fill for the selected-citation surface. */
    selected?: boolean;
};

/**
 * The inset slab that holds quoted or proposed text inside a card — a citation
 * quote, a tracked-change diff, and the loading and empty states standing in
 * for either.
 *
 * Owns shape, padding, and fill only. Typography belongs to the caller, since
 * quoted source text is serif while a diff is sans.
 *
 * The fill is emitted as exactly one class rather than layering an override on
 * top of a default: `.citation-quote-selected` and `.bg-gray-100` are both
 * single-class selectors, so which one won would come down to stylesheet
 * order.
 */
export function TextSlabUI({
    children,
    className,
    selected = false,
    ...props
}: TextSlabUIProps): ReactElement {
    return (
        <div
            className={twMerge(
                clsx(
                    "rounded-xl px-3 py-2",
                    selected ? "citation-quote-selected" : "bg-gray-100",
                    className,
                ),
            )}
            {...props}
        >
            {children}
        </div>
    );
}
