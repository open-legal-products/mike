import { useEffect, useRef } from "react";
import { isVisualFilename } from "@/shared/lib/visualBridge";
import type { AssistantEvent, Message } from "../shared/types";
import { withDelegationEvents } from "./message/eventUtils";

type VisualCreated = {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
};

export function latestVisualInTurn(
    events: AssistantEvent[],
): VisualCreated | null {
    let latest: VisualCreated | null = null;
    for (const event of events) {
        if (event.type !== "doc_created" && event.type !== "doc_edited") continue;
        if (event.isStreaming || ("error" in event && event.error)) continue;
        if (!event.document_id || !isVisualFilename(event.filename)) continue;
        latest = {
            documentId: event.document_id,
            filename: event.filename,
            versionId: event.version_id ?? null,
            versionNumber: event.version_number ?? null,
        };
    }
    return latest;
}

// A visual the assistant draws or edits during a live turn opens by itself
// at its newest version; a reloaded history never does.
export function useAutoOpenTurnVisual(
    messages: Message[],
    isResponseLoading: boolean,
    open: (visual: VisualCreated) => unknown,
): void {
    const openedTurnRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isResponseLoading) return;
        const index = messages.length - 1;
        const last = messages[index];
        if (last?.role !== "assistant") return;
        const visual = latestVisualInTurn(
            withDelegationEvents(last.events ?? []),
        );
        if (!visual) return;
        const key = `${last.id ?? `turn:${index}`}:${visual.versionId ?? visual.documentId}`;
        if (openedTurnRef.current === key) return;
        openedTurnRef.current = key;
        void open(visual);
    }, [messages, isResponseLoading, open]);
}
