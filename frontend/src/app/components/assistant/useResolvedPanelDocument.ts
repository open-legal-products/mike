"use client";

import { useCallback, useEffect, useState } from "react";
import { getPanelDocument } from "@/app/lib/mikeApi";
import type { PanelDocument } from "../shared/types";

function mergePanelDocuments(
    summary: PanelDocument,
    loaded: PanelDocument,
): PanelDocument {
    return {
        ...loaded,
        title:
            summary.title && summary.title !== "Case"
                ? summary.title
                : loaded.title,
        metadata: summary.metadata.length ? summary.metadata : loaded.metadata,
        actions: summary.actions?.length ? summary.actions : loaded.actions,
        quotes: summary.quotes.length ? summary.quotes : loaded.quotes,
    };
}

function friendlyDocumentError(message: string): string {
    try {
        const parsed = JSON.parse(message) as { detail?: unknown };
        if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
        // Keep the original message.
    }
    if (message.includes("429") || /rate limit|throttled/i.test(message)) {
        const wait = message.match(/available in\s+(\d+)\s+seconds/i)?.[1];
        return wait
            ? `This source is temporarily rate limited. Please try again in about ${wait} seconds.`
            : "This source is temporarily rate limited. Please try again shortly.";
    }
    return "Could not load this document. Please try again shortly.";
}

export function useResolvedPanelDocument(document: PanelDocument): {
    document: PanelDocument;
    isLoading: boolean;
    error: string | null;
    retry: () => void;
} {
    const documentId = document.document_id;
    const needsHydration =
        document.type === "case" && !document.subdocuments?.length;
    const [request, setRequest] = useState<{
        documentId: string;
        loaded: PanelDocument | null;
        loading: boolean;
        error: string | null;
    } | null>(null);
    const [requestVersion, setRequestVersion] = useState(0);
    const retry = useCallback(
        () => setRequestVersion((current) => current + 1),
        [],
    );

    useEffect(() => {
        if (!needsHydration) return;
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- start the request for a new case or explicit retry
        setRequest({ documentId, loaded: null, loading: true, error: null });
        void getPanelDocument(documentId)
            .then((loaded) => {
                if (!cancelled)
                    setRequest({
                        documentId,
                        loaded,
                        loading: false,
                        error: null,
                    });
            })
            .catch((reason: unknown) => {
                if (!cancelled)
                    setRequest({
                        documentId,
                        loaded: null,
                        loading: false,
                        error:
                            reason instanceof Error
                                ? friendlyDocumentError(reason.message)
                                : "Could not load this document.",
                    });
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, needsHydration, requestVersion]);

    // File metadata is complete: pass the current version through synchronously
    // with its refetch key. Case hydration is keyed by identity, not by incoming
    // summary objects, which can change on every chat token or quote selection.
    if (!needsHydration)
        return { document, isLoading: false, error: null, retry };
    const currentRequest = request?.documentId === documentId ? request : null;
    return {
        document: currentRequest?.loaded
            ? mergePanelDocuments(document, currentRequest.loaded)
            : document,
        isLoading: currentRequest?.loading ?? true,
        error: currentRequest?.error ?? null,
        retry,
    };
}
