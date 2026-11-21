"use client";

import type { ReactElement } from "react";
import { ClipboardCheck, X } from "lucide-react";

/**
 * The pill for a playbook attached to a chat message, shared by the web and
 * Word composers (with `onRemove`) and the Word thread (without). `onOpen`
 * makes the name a button, which the web composer uses to reopen its picker.
 */
export function PlaybookPillUI({
    title,
    onOpen,
    onRemove,
}: {
    title: string;
    onOpen?: () => void;
    onRemove?: () => void;
}): ReactElement {
    const name = (
        <>
            <ClipboardCheck aria-hidden="true" className="h-2.5 w-2.5 shrink-0" />
            <span className="max-w-[140px] truncate">{title}</span>
        </>
    );
    return (
        <div
            className={`inline-flex items-center gap-1 rounded-full border bg-slate-700 py-0.5 text-xs text-white shadow ${
                onRemove
                    ? "border-white/20 pl-2.5 pr-1"
                    : "border-slate-700 pl-2 pr-2.5"
            }`}
        >
            {onOpen ? (
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={`Open playbook ${title}`}
                    className="inline-flex min-w-0 items-center gap-1 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                    {name}
                </button>
            ) : (
                name
            )}
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Remove playbook ${title}`}
                    className="ml-0.5 rounded-full p-0.5 text-white/60 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                    <X aria-hidden="true" className="h-2.5 w-2.5" />
                </button>
            )}
        </div>
    );
}
