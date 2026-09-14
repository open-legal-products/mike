"use client";

import { MessageSquareQuote, X } from "lucide-react";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

interface ChipProps {
    excerpt: string;
    /** 1-based position, used only for the remove button's accessible name. */
    index: number;
    onRemove: () => void;
}

/**
 * One attached excerpt, sitting above the composer until the next message is
 * sent. The quote is clamped to two lines with the full text on `title`, so a
 * long excerpt never pushes the textarea off screen.
 */
export function QuotedExcerptChip({ excerpt, index, onRemove }: ChipProps) {
    return (
        <div
            className={cn(
                "flex min-w-0 max-w-full items-start gap-1.5 rounded-[10px] py-1 pl-2 pr-1 text-xs text-gray-800",
                LIQUID_GLASS_FLAT_CLASS,
            )}
        >
            <MessageSquareQuote
                className="mt-0.5 h-2.5 w-2.5 shrink-0 text-gray-400"
                aria-hidden
            />
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[10px] leading-none text-gray-500">
                    Quoted from response
                </span>
                <span
                    title={excerpt}
                    className="line-clamp-2 max-w-[280px] text-gray-700"
                >
                    {excerpt}
                </span>
            </span>
            <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove quoted excerpt ${index}`}
                className="mt-0.5 shrink-0 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1"
            >
                <X className="h-2.5 w-2.5" />
            </button>
        </div>
    );
}

interface ListProps {
    excerpts: readonly string[];
    onRemove: (index: number) => void;
    /** Shown when the last attached excerpt had to be shortened. */
    notice?: string | null;
    className?: string;
}

/** The stack of attached excerpts rendered above a composer. */
export function QuotedExcerptChips({
    excerpts,
    onRemove,
    notice,
    className,
}: ListProps) {
    if (excerpts.length === 0 && !notice) return null;
    return (
        <div className={cn("flex flex-col gap-1", className)}>
            {excerpts.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Quoted excerpts">
                    {excerpts.map((excerpt, index) => (
                        <li key={`${index}-${excerpt.slice(0, 24)}`} className="min-w-0">
                            <QuotedExcerptChip
                                excerpt={excerpt}
                                index={index + 1}
                                onRemove={() => onRemove(index)}
                            />
                        </li>
                    ))}
                </ul>
            )}
            {notice && (
                <p role="status" className="text-[10px] text-gray-500">
                    {notice}
                </p>
            )}
        </div>
    );
}
