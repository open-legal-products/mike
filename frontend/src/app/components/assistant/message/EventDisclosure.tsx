"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * The pieces every event block's first line is built from. They exist so the
 * timeline reads as one thing: before this, each block hand-rolled its own
 * chevron size, rotation direction, and hover shade, and they disagreed.
 *
 * Colour and font come from `EventBlock`'s wrapper — nothing here restates
 * them, so a block that is nested somewhere else still inherits correctly.
 */

/** The bold lead-in of an event line ("Created", "Read Workflow", …). */
export function EventLabel({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return <span className={cn("font-medium", className)}>{children}</span>;
}

/**
 * The disclosure chevron: pointing right when closed, down when open, so the
 * direction always means "where the content is".
 */
export function EventChevron({ open }: { open: boolean }) {
    return (
        <ChevronDown
            size={10}
            aria-hidden="true"
            className={cn(
                "relative top-px ml-1 shrink-0 transition-transform duration-200",
                open ? "" : "-rotate-90",
            )}
        />
    );
}

/**
 * A whole event line that opens something: label, optional detail, the
 * streaming ellipsis, and the chevron. Always reports `aria-expanded`, which
 * one of the hand-rolled versions used to forget.
 */
export function EventDisclosureButton({
    open,
    onToggle,
    label,
    detail,
    isStreaming,
}: {
    open: boolean;
    onToggle: () => void;
    label: ReactNode;
    detail?: ReactNode;
    /** Appends the in-progress ellipsis the timeline uses elsewhere. */
    isStreaming?: boolean;
}) {
    return (
        <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="inline-flex items-center text-left transition-colors hover:text-gray-700"
        >
            <span className="min-w-0">
                <EventLabel>{label}</EventLabel>
                {detail ? <>&nbsp;{detail}</> : null}
                {isStreaming ? "..." : null}
            </span>
            <EventChevron open={open} />
        </button>
    );
}
