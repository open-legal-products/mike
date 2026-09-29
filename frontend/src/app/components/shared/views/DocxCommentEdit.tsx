"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";
import { useEffect, useId, useRef, useState } from "react";
import type {
    Editor,
    ReviewCommentPlacement,
} from "@docx-editor.dev/core/contracts/editor";
import { useEditorSnapshot } from "@docx-editor.dev/react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { docxEditComment } from "./docxCommentEditing";

export function DocxCommentEdit({
    editor,
    comment,
    author,
    onClose,
}: {
    editor: Editor;
    comment: ReviewCommentPlacement;
    author?: string;
    onClose: () => void;
}) {
    useEditorSnapshot(editor);
    const [draft, setDraft] = useState(comment.text);
    const [error, setError] = useState<string | null>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const id = useId();
    useEffect(() => {
        const field = input.current;
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
    }, []);
    const snapshot = editor.snapshot();
    const disabled =
        !draft.trim() ||
        draft.trim() === comment.text.trim() ||
        !author?.trim() ||
        !snapshot.editable ||
        snapshot.editingMode === "viewing";
    const submit = () => {
        if (disabled || !author) return;
        const failure =
            "Your edit could not be saved. Your draft is kept; please try again.";
        try {
            if (docxEditComment(editor, comment, draft.trim(), author))
                onClose();
            else setError(failure);
        } catch {
            setError(failure);
        }
    };
    return (
        <form
            className="space-y-2"
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
            <label htmlFor={id} className="sr-only">
                Edit comment
            </label>
            <textarea
                id={id}
                ref={input}
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className={`${FORM_CONTROL_GLASS_CLASS} min-h-20 resize-y py-2`}
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
                    Save
                </PillButtonUI>
            </div>
        </form>
    );
}
