"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";

/**
 * PdfView's loader. /display returns PDF bytes (a stored or on-demand PDF
 * rendition) for the files PdfView shows. Anything else is reported as
 * "docx" so a caller can route it to DocxView. Spreadsheets and .docx files
 * read their raw bytes from /file instead (see useFetchDocxBytes).
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
    displayUrl?: string | null,
    refetchKey?: number | string,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!documentId) {
            setResult(null);
            setLoading(false);
            setError(null);
            return;
        }
        const controller = new AbortController();

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                if (cancelled) return;
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await authenticatedFetch(
                    displayUrl ??
                        `${API_BASE}/single-documents/${documentId}/display${qs}`,
                    { credentials: "include", signal: controller.signal },
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType = response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer. Callers
                    // should route DOC/DOCX files to DocxView directly.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [displayUrl, documentId, versionId, refetchKey]);

    return { result, loading, error };
}
