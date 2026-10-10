"use client";

import { Modal } from "../modals/Modal";
import { FieldLabel } from "../ui/form-field";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import type { MessageExcerpt } from "@/app/lib/messageExcerpts";

/**
 * The full text behind a composer excerpt pill: the quoted passage and, when
 * the reader annotated it, their note.
 */
export function ExcerptModal({
    excerpt,
    onClose,
}: {
    /** Null keeps the modal closed. */
    excerpt: MessageExcerpt | null;
    onClose: () => void;
}) {
    return (
        <Modal
            open={!!excerpt}
            onClose={onClose}
            size="sm"
            className="h-auto"
            breadcrumbs={[
                "Assistant",
                excerpt?.note ? "Annotated Excerpt" : "Excerpt",
            ]}
        >
            {excerpt && (
                <div className="flex flex-col gap-4 pb-5">
                    <div>
                        <FieldLabel as="p">Excerpt</FieldLabel>
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
                            <FieldLabel as="p">Annotation</FieldLabel>
                            <p className="break-words text-sm text-gray-900">
                                {excerpt.note}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}
