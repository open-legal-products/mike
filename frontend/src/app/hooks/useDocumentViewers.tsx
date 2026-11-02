"use client";

import { useCallback, useRef, useState } from "react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { downloadDocumentFile } from "@/app/lib/downloadDocument";
import type { DocxCloseGuard } from "@/app/components/shared/views/DocxRenderer.types";

/** Share live editor downloads and protect closing/replacing dirty viewers. */
export function useDocumentViewers() {
    const downloads = useRef(new Map<string, () => Promise<void>>());
    const guards = useRef(new Map<string, DocxCloseGuard>());
    const busy = useRef(false);
    const [pending, setPending] = useState<{ guards: DocxCloseGuard[]; close: () => void } | null>(null);
    const registerDownload = useCallback((id: string, download: (() => Promise<void>) | null) => {
        if (download) downloads.current.set(id, download);
        else downloads.current.delete(id);
    }, []);
    const registerCloseGuard = useCallback((id: string, guard: DocxCloseGuard | null) => {
        if (guard) guards.current.set(id, guard);
        else guards.current.delete(id);
    }, []);
    const download = useCallback((id: string, documentId: string, versionId?: string | null, filename?: string) => {
        const live = downloads.current.get(id);
        return live ? live() : downloadDocumentFile(documentId, versionId, filename);
    }, []);
    // Call only after confirmed deletion succeeds. A cancelled/failed deletion
    // must retain its draft; a deleted document must not save again on unmount.
    const discardDeleted = useCallback((ids: string[]) => {
        ids.forEach((id) => guards.current.get(id)?.discard());
    }, []);
    const requestClose = useCallback((ids: string[], close: () => void) => {
        if (busy.current) return;
        const selected = ids.flatMap((id) => {
            const guard = guards.current.get(id);
            return guard ? [guard] : [];
        });
        if (!selected.some((guard) => guard.hasUnsavedChanges())) { close(); return; }
        busy.current = true;
        void Promise.all(selected.map((guard) => guard.prepareClose().catch(() => false))).then((saved) => {
            if (saved.every(Boolean)) { busy.current = false; close(); }
            else setPending({ guards: selected, close });
        });
    }, []);
    const confirmation = <ConfirmPopup
        open={!!pending}
        title="Discard unsaved changes?"
        message="Your changes could not be saved. Keep the document open to retry or download a copy, or discard the unsaved changes."
        confirmLabel="Discard changes"
        confirmVariant="danger"
        cancelLabel="Keep editing"
        onCancel={() => { setPending(null); busy.current = false; }}
        onConfirm={() => {
            pending?.guards.forEach((guard) => guard.discard());
            pending?.close();
            setPending(null);
            busy.current = false;
        }}
    />;
    return { registerDownload, registerCloseGuard, download, requestClose, discardDeleted, confirmation };
}
