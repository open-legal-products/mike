// The hook reads the mutable editor facade (snapshot, revision); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";

import { useLayoutEffect, useState } from "react";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";

// EigenPal opens its review pane by itself whenever an edit is recorded as a
// tracked change, and offers no option to stop it: in suggesting mode the
// first keystroke opened Mike's comment column. That open always lands with a
// new document revision. A deliberate open never edits the document — the
// toolbar's Comments button — or is announced through `openReviewPane`, for
// Mike's flows that open the pane right after an edit such as adding a comment.
const requested = new WeakSet<Editor>();

/** Open the comment pane on purpose, even in the same step as an edit. */
export function openReviewPane(editor: Editor) {
    if (editor.snapshot().reviewPaneOpen) return;
    requested.add(editor);
    editor.exec({ type: "toggleReviewPane" });
}

/**
 * Whether the comment pane is open on purpose. Undoes the engine's own open,
 * before paint, so the column never flashes and the page never relayouts.
 */
export function useRequestedReviewPane(editor: Editor | null) {
    const engineOpen = editor?.snapshot().reviewPaneOpen ?? false;
    const revision = editor?.getDocumentHandle?.().revision ?? 0;
    // What the engine last showed, and whether Mike honours it.
    const [seen, setSeen] = useState({
        editor,
        engineOpen,
        revision,
        open: engineOpen,
    });
    let open = seen.open;
    if (
        seen.editor !== editor ||
        seen.engineOpen !== engineOpen ||
        seen.revision !== revision
    ) {
        if (!engineOpen || seen.editor !== editor) open = engineOpen;
        // Just opened: honoured unless an edit, not a request, opened it.
        else if (!seen.engineOpen)
            open =
                seen.revision === revision ||
                (editor !== null && requested.has(editor));
        setSeen({ editor, engineOpen, revision, open });
    }
    useLayoutEffect(() => {
        if (!editor) return;
        if (open) requested.delete(editor);
        else if (engineOpen) editor.exec({ type: "toggleReviewPane" });
    }, [editor, engineOpen, open]);
    return open;
}
