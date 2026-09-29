"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";
import { useEffect, useId, useRef, useState } from "react";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { useEditorSnapshot } from "@docx-editor.dev/react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";

export function DocxCommentReply({
    editor,
    commentKey,
    author,
    onClose,
}: {
    editor: Editor;
    commentKey: string;
    author?: string;
    onClose: () => void;
}) {
    useEditorSnapshot(editor);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const id = useId();
    useEffect(() => {
        input.current?.focus();
    }, []);
    const snapshot = editor.snapshot();
    const disabled =
        !draft.trim() ||
        !author?.trim() ||
        !snapshot.editable ||
        snapshot.editingMode === "viewing";
    const submit = () => {
        if (disabled) return;
        try {
            const result = editor.replyToReviewItem(
                commentKey,
                draft.trim(),
                author,
            );
            if (result.ok) onClose();
            else
                setError(
                    "Your reply could not be added. Your draft is kept; please try again.",
                );
        } catch {
            setError(
                "Your reply could not be added. Your draft is kept; please try again.",
            );
        }
    };
    return (
        <form
            className="mt-3 space-y-2"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    onClose();
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    submit();
                }
            }}
        >
            <label htmlFor={id} className="block font-medium">
                Reply to comment
            </label>
            <textarea
                id={id}
                ref={input}
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className={`${FORM_CONTROL_GLASS_CLASS} min-h-20 resize-y py-2`}
                placeholder="Write a reply…"
            />
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
            <div className="flex justify-end gap-2">
                <TextButtonUI onClick={onClose}>Cancel</TextButtonUI>
                <PillButtonUI
                    type="submit"
                    size="xs"
                    tone="black"
                    disabled={disabled}
                >
                    Reply
                </PillButtonUI>
            </div>
        </form>
    );
}
