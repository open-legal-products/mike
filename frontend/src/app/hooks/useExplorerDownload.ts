"use client";

import { useRef, useState } from "react";
import { downloadDocumentsZip, getDocumentUrl } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Document, Folder } from "@/app/components/shared/types";

export function useExplorerDownload() {
    const busyRef = useRef(false);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function download(target: {
        kind: "document" | "folder";
        id: string;
        filename: string;
    }) {
        if (busyRef.current) return;
        busyRef.current = true;
        setDownloading(true);
        setError(null);
        let objectUrl: string | null = null;
        try {
            let url: string;
            let filename = target.filename;
            if (target.kind === "document") {
                const file = await getDocumentUrl(target.id);
                url = file.url;
                filename = file.filename || filename;
            } else {
                const archive = await downloadDocumentsZip([], [target.id]);
                objectUrl = URL.createObjectURL(archive);
                url = objectUrl;
            }
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "The file or folder could not be downloaded. Please try again.",
                ),
            );
        } finally {
            if (objectUrl) {
                const completedUrl = objectUrl;
                window.setTimeout(() => URL.revokeObjectURL(completedUrl), 1000);
            }
            busyRef.current = false;
            setDownloading(false);
        }
    }

    return {
        downloading,
        error,
        clearError: () => setError(null),
        downloadDocument: (document: Document) =>
            download({
                kind: "document",
                id: document.id,
                filename: document.filename,
            }),
        downloadFolder: (folder: Folder) =>
            download({
                kind: "folder",
                id: folder.id,
                filename: `${folder.name}.zip`,
            }),
    };
}
