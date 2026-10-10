"use client";

import type { ReactElement } from "react";
import { ModalUI } from "./ModalUI";
import { TextSlabUI } from "./TextSlabUI";
import { excerptLabel } from "./ExcerptPillUI";
import type { MessageExcerpt } from "../lib/messageExcerpts";

const LABEL_CLASS = "mb-2 text-sm font-medium text-gray-700";

/**
 * The full text behind an excerpt pill: the quoted passage and, when the
 * reader annotated it, their note.
 */
export function ExcerptModalUI({
    excerpt,
    onClose,
}: {
    /** Null keeps the modal closed. */
    excerpt: MessageExcerpt | null;
    onClose: () => void;
}): ReactElement {
    const title = excerpt ? excerptLabel(excerpt) : "Excerpt";
    return (
        <ModalUI
            open={!!excerpt}
            onClose={onClose}
            size="sm"
            className="h-auto"
            breadcrumbs={["Assistant", title]}
            ariaLabel={title}
        >
            {excerpt && (
                <div className="flex flex-col gap-4 pb-5">
                    <div>
                        <p className={LABEL_CLASS}>Excerpt</p>
                        {/* Long passages scroll inside the slab; focusable so
                            the scroll is reachable by keyboard. */}
                        <TextSlabUI
                            tabIndex={0}
                            className="max-h-60 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            <p className="whitespace-pre-wrap break-words font-serif text-sm leading-6 text-gray-600">
                                {excerpt.text}
                            </p>
                        </TextSlabUI>
                    </div>
                    {excerpt.note && (
                        <div>
                            <p className={LABEL_CLASS}>Annotation</p>
                            <p className="break-words text-sm text-gray-900">
                                {excerpt.note}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </ModalUI>
    );
}
