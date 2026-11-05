import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { Document } from "../components/shared/types";
import { getDocumentStatuses } from "../lib/mikeApi";
import { settleWithConcurrency } from "@/shared/lib/settleWithConcurrency";

export function useDocumentConversionPolling(documents: Document[], setDocuments: Dispatch<SetStateAction<Document[]>>) {
    const pendingKey = JSON.stringify(documents
        .filter(document => document.status === "pending" || document.status === "processing")
        .map(document => document.id));
    useEffect(() => {
        const ids: string[] = JSON.parse(pendingKey);
        if (!ids.length) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const batches: string[][] = [];
        for (let start = 0; start < ids.length; start += 100) batches.push(ids.slice(start, start + 100));
        const poll = async () => {
            const results = await settleWithConcurrency(batches, 2, batch =>
                controller.signal.aborted ? Promise.resolve([]) : getDocumentStatuses(batch, controller.signal));
            if (controller.signal.aborted) return;
            const latest = new Map(results.flatMap(result => result.status === "fulfilled" ? result.value.map(document => [document.id, document] as const) : []));
            setDocuments(previous => {
                let changed = false;
                const next = previous.map(document => {
                    const update = latest.get(document.id);
                    if (!update || update.status === document.status) return document;
                    changed = true;
                    return { ...document, ...update };
                });
                return changed ? next : previous;
            });
            // Failed batches retry silently; never overlap a slow previous poll.
            timer = setTimeout(() => { void poll(); }, 3000);
        };
        timer = setTimeout(() => { void poll(); }, 3000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [pendingKey, setDocuments]);
}
