"use client";

import { useEffect, useState } from "react";
import { getDocumentComparison } from "@/app/lib/mikeApi";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { notifyError, reportFault } from "@/app/lib/userFacingError";
import { versionLabel, type VersionComparison } from "@/app/components/shared/versionComparison";

export interface OpenComparison {
    pair: VersionComparison;
    filename: string;
    download: () => Promise<void>;
    bytes?: ArrayBuffer;
    error?: { message: string; retryable: boolean };
}

export function useDocumentComparison(
    documentId: string | null,
    versionId: string | null,
    onDownloadReady?: (download: (() => Promise<void>) | null) => void,
) {
    const [current, setCurrent] = useState<(OpenComparison & {
        documentId: string; versionId: string | null; controller: AbortController;
    }) | null>(null);
    if (current && (current.documentId !== documentId || current.versionId !== versionId)) setCurrent(null);

    const controller = current?.controller;
    useEffect(() => () => controller?.abort(), [controller]);
    const download = current?.download;
    useEffect(() => {
        if (!download) return;
        onDownloadReady?.(download);
        return () => onDownloadReady?.(null);
    }, [onDownloadReady, download]);

    function open(pair: VersionComparison) {
        if (!documentId) return;
        const controller = new AbortController();
        const { base, target } = pair;
        const stem = (target.filename || base.filename || "document").replace(/\.docx$/i, "");
        const filename = `${stem} (${versionLabel(base)} to ${versionLabel(target)} comparison).docx`;
        const request = getDocumentComparison(documentId, base.id, target.id, controller.signal);
        // The tab menu can request the file before the title's download button is ready.
        async function download() {
            const bytes = await request.catch(() => null); // Fetch failures are shown in the canvas.
            if (!bytes || controller.signal.aborted) return;
            try {
                downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), filename);
            } catch (cause) {
                notifyError(cause, { action: "download the comparison", operation: "documents.directory" });
            }
        }
        const selection = { documentId, versionId, controller, pair, filename, download };
        setCurrent(selection);
        void request.then(bytes => {
            setCurrent(active => active === selection ? { ...selection, bytes } : active);
        }, cause => {
            if (controller.signal.aborted) return;
            const { message, retryable } = reportFault(cause, { action: "compare these versions", operation: "documents.directory" });
            const error = { message, retryable };
            setCurrent(active => active === selection ? { ...selection, error } : active);
        });
    }

    return { comparison: current, open, close: () => setCurrent(null) };
}
