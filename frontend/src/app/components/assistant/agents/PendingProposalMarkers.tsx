"use client";

import { PencilLine } from "lucide-react";
import { cn } from "@/app/lib/utils";

interface Props {
    /** Assigned regions of this response that still have unresolved proposals. */
    excerpts: readonly string[];
    onOpen: (excerpt: string) => void;
}

/**
 * Marks the parts of a response an agent has proposed changes to.
 *
 * The marker is rendered under the response rather than as an inline underline
 * inside it. The prose is produced by the markdown renderer, and wrapping a
 * substring in place would mean splitting text nodes React owns — a reliable
 * way to make a re-render throw. A row of underlined region chips says the same
 * thing (this passage has a pending edit), stays inside React's tree, and gives
 * the region something to click.
 */
export function PendingProposalMarkers({ excerpts, onOpen }: Props) {
    if (excerpts.length === 0) return null;

    return (
        <ul
            aria-label="Regions with proposed edits"
            className="mt-2 flex flex-wrap items-center gap-1.5"
        >
            {excerpts.map((excerpt) => (
                <li key={excerpt} className="min-w-0">
                    <button
                        type="button"
                        onClick={() => onOpen(excerpt)}
                        className={cn(
                            "flex max-w-xs cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] text-gray-600 transition-colors hover:text-gray-900",
                            "underline decoration-blue-400 decoration-dotted underline-offset-4",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                        )}
                    >
                        <PencilLine className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">{excerpt}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}
