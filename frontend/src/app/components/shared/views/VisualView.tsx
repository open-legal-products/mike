"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { useDarkTheme } from "@/shared/hooks/useDarkTheme";
import { VisualViewUI } from "@/shared/ui/VisualViewUI";
import { STALE_SOURCE_NOTICE, type VisualCite } from "@/shared/lib/visualBridge";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { getDocument, getVisualSnapshot, type VisualSnapshot } from "@/app/lib/mikeApi";
import { citationFromVisualCite } from "@/app/lib/visualCitation";
import type { DocumentCitation } from "../types";
import { viewRoundingClass, type ViewRounding } from "./viewRounding";

export type OpenVisualCitation = (
    citation: DocumentCitation,
    options?: { showQuotes?: boolean },
) => void;

interface Props {
    documentId: string;
    versionId?: string | null;
    filename: string;
    refetchKey?: number | string;
    cacheBytes?: boolean;
    rounded?: ViewRounding;
    active?: boolean;
    onOpenCitation?: OpenVisualCitation;
    onDownloadReady?: (download: (() => Promise<void>) | null) => void;
}

export function VisualView({
    documentId,
    versionId,
    filename,
    refetchKey,
    cacheBytes = true,
    rounded = true,
    active = true,
    onOpenCitation,
    onDownloadReady,
}: Props) {
    const darkTheme = useDarkTheme();
    const [reloadKey, setReloadKey] = useState(0);
    const { bytes, loading, error } = useFetchDocxBytes(
        documentId,
        versionId,
        reloadKey ? `${refetchKey ?? ""}:${reloadKey}` : refetchKey,
        undefined,
        cacheBytes,
    );
    const html = useMemo(
        () => (bytes ? new TextDecoder().decode(bytes) : null),
        [bytes],
    );
    const [snapshot, setSnapshot] = useState<VisualSnapshot | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        getVisualSnapshot(documentId, versionId, controller.signal)
            .then((loaded) => {
                if (!controller.signal.aborted) setSnapshot(loaded);
            })
            .catch(() => {
                // The stale notice is a courtesy; the visual itself still
                // loads and its own failure is what the user needs to hear.
            });
        return () => controller.abort();
    }, [documentId, versionId, refetchKey]);

    useEffect(() => {
        if (!html || !onDownloadReady) return;
        onDownloadReady(async () => {
            downloadBlob(
                new Blob([html], { type: "text/html;charset=utf-8" }),
                filename,
            );
        });
        return () => onDownloadReady(null);
    }, [html, filename, onDownloadReady]);

    const handleCite = useCallback(
        (cite: VisualCite) => {
            if (!onOpenCitation) return;
            const known = snapshot?.sources.find(
                (source) => source.document_id === cite.cite,
            );
            const citation = citationFromVisualCite(cite, known?.filename);
            if (!citation) return;
            const options = { showQuotes: !!cite.quote };
            if (citation.filename) {
                onOpenCitation(citation, options);
                return;
            }
            void getDocument(cite.cite).then(
                (document) =>
                    onOpenCitation({ ...citation, filename: document.filename }, options),
                // A refused lookup is reported by the citation path itself,
                // which re-checks access on a versionless citation.
                () =>
                    onOpenCitation(
                        { ...citation, filename: cite.cite, version_id: null },
                        options,
                    ),
            );
        },
        [onOpenCitation, snapshot],
    );

    const stale = snapshot?.sources.some((source) => source.stale) ?? false;

    return (
        <div
            className={`document-canvas relative flex min-h-0 flex-1 flex-col overflow-hidden ${viewRoundingClass(rounded)}`}
        >
            {stale && (
                <p className="shrink-0 break-words px-3 pb-2 text-xs text-amber-700">
                    {STALE_SOURCE_NOTICE}
                </p>
            )}
            <VisualViewUI
                html={html ?? ""}
                title={filename}
                theme={darkTheme ? "dark" : "light"}
                loading={loading || (!html && !error)}
                error={error}
                onRetry={() => setReloadKey((current) => current + 1)}
                active={active}
                onCite={onOpenCitation ? handleCite : undefined}
            />
        </div>
    );
}

export default VisualView;
