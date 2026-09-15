"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const PROJECT_WORKSPACE_TIPS = [
    "You can drag and drop a document from the Explorer to the Chat.",
    "Ask the Chat to explain a difficult passage or summarise a project document.",
    "Ask the Chat to edit a project document and save the changes as a new version.",
    "The Chat can create a new project document using your instructions and project context.",
    "Ask the Chat to replicate an existing document when you want a new draft based on it.",
];

export function ProjectWorkspaceTips() {
    const [tipIndex, setTipIndex] = useState(0);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- randomising after mount avoids a server/client hydration mismatch
        setTipIndex(Math.floor(Math.random() * PROJECT_WORKSPACE_TIPS.length));
    }, []);

    function rotateTip(direction: -1 | 1) {
        setTipIndex(
            (current) =>
                (current + direction + PROJECT_WORKSPACE_TIPS.length) %
                PROJECT_WORKSPACE_TIPS.length,
        );
    }

    return (
        <div className="inline-flex max-w-xl flex-col items-center gap-2 text-gray-600">
            <p
                aria-live="polite"
                className="min-w-0 rounded-full bg-app-surface px-4 py-2 text-xs"
            >
                <strong>Tip:</strong> {PROJECT_WORKSPACE_TIPS[tipIndex]}
            </p>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    aria-label="Previous tip"
                    onClick={() => rotateTip(-1)}
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-app-surface-active/50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <span
                    aria-label={`Tip ${tipIndex + 1} of ${PROJECT_WORKSPACE_TIPS.length}`}
                    className="min-w-8 text-center text-[10px] tabular-nums text-gray-500"
                >
                    {tipIndex + 1}/{PROJECT_WORKSPACE_TIPS.length}
                </span>
                <button
                    type="button"
                    aria-label="Next tip"
                    onClick={() => rotateTip(1)}
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-app-surface-active/50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}
