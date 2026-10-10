"use client";

import type { ReactElement } from "react";
import { MessageSquare, TextQuote, X } from "lucide-react";
import { LIQUID_GLASS_FLAT_CLASS } from "./LiquidGlassUI";
import type { MessageExcerpt } from "../lib/messageExcerpts";

/** What a pill calls an excerpt: it names the kind, not the passage. */
export function excerptLabel(excerpt: MessageExcerpt): string {
    return excerpt.note ? "Annotated Excerpt" : "Excerpt";
}

/**
 * The pill for a passage quoted from an assistant response, in the composer
 * (with `onRemove`) and in a sent message (without). Clicking it opens the
 * passage; the pill itself only says whether it carries a note.
 */
export function ExcerptPillUI({
    excerpt,
    onOpen,
    onRemove,
}: {
    excerpt: MessageExcerpt;
    onOpen: () => void;
    onRemove?: () => void;
}): ReactElement {
    const Icon = excerpt.note ? MessageSquare : TextQuote;
    const preview = excerpt.text.slice(0, 60);
    return (
        <div
            className={`inline-flex max-w-full items-center rounded-[10px] text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS}`}
        >
            <button
                type="button"
                onClick={onOpen}
                aria-label={`View excerpt: ${preview}`}
                className={`inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-[10px] py-0.5 pl-2 transition-colors hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${
                    onRemove ? "" : "pr-2.5"
                }`}
            >
                <Icon aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
                <span>{excerptLabel(excerpt)}</span>
            </button>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Remove excerpt: ${preview}`}
                    className="mx-1 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    <X aria-hidden="true" className="h-2.5 w-2.5" />
                </button>
            )}
        </div>
    );
}
