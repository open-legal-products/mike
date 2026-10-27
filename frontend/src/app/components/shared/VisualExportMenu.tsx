"use client";

import { useEffect, useState } from "react";
import { downloadBlob } from "@/app/lib/downloadDocument";
import {
    createDocxFromVisual,
    exportVisual,
    getVisualExportCapabilities,
    type VisualExportCapabilities,
} from "@/app/lib/mikeApi";
import { notifyError, notifySuccess } from "@/app/lib/userFacingError";
import { visualTitle } from "@/shared/lib/visualBridge";
import {
    VisualExportMenuUI,
    type VisualExportItem,
} from "@/shared/ui/VisualExportMenuUI";

let capabilitiesRequest: Promise<VisualExportCapabilities> | null = null;

function loadCapabilities(): Promise<VisualExportCapabilities> {
    capabilitiesRequest ??= getVisualExportCapabilities().catch((error) => {
        capabilitiesRequest = null;
        throw error;
    });
    return capabilitiesRequest;
}

const RENDER_MESSAGES = {
    render_unavailable: "Export is not available on this server.",
    render_busy: "The server is busy rendering other visuals. Try again in a moment.",
    render_timeout: "Rendering took too long. Try again.",
    render_failed: "This visual could not be rendered.",
    not_a_visual: "This document is not a visual.",
} as const;

function exportFilename(filename: string, extension: string): string {
    return `${visualTitle(filename)}.${extension}`;
}

export function VisualExportMenu({
    documentId,
    versionId,
    filename,
    onDownloadHtml,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    onDownloadHtml: () => Promise<void> | undefined;
}) {
    const [capabilities, setCapabilities] = useState<VisualExportCapabilities | null>(null);
    const [busyItem, setBusyItem] = useState<VisualExportItem | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadCapabilities().then(
            (loaded) => {
                if (!cancelled) setCapabilities(loaded);
            },
            () => {
                // Without the answer the image items stay hidden; the HTML
                // download and the Word document need no renderer.
            },
        );
        return () => {
            cancelled = true;
        };
    }, []);

    const run = async (item: VisualExportItem, action: string, work: () => Promise<void>) => {
        if (busyItem) return;
        setBusyItem(item);
        try {
            await work();
        } catch (error) {
            notifyError(error, {
                action,
                codeMessages: RENDER_MESSAGES,
                onRetry: () => void run(item, action, work),
            });
        } finally {
            setBusyItem(null);
        }
    };

    const downloadPdf = () =>
        void run("pdf", "download the PDF", async () => {
            const blob = await exportVisual(documentId, versionId);
            downloadBlob(blob, exportFilename(filename, "pdf"));
        });

    return (
        <VisualExportMenuUI
            busyItem={busyItem}
            onDownloadHtml={() =>
                void run("html", "download the visual", async () => {
                    await onDownloadHtml();
                })
            }
            onDownloadPdf={capabilities?.pdf ? downloadPdf : undefined}
            onCreateDocx={
                capabilities?.docx
                    ? () =>
                          void run("docx", "create the Word document", async () => {
                              const created = await createDocxFromVisual(documentId, versionId);
                              notifySuccess(`${created.filename} was added to your documents.`);
                          })
                    : undefined
            }
        />
    );
}
