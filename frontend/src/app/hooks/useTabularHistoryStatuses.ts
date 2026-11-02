"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TabularReview } from "@/app/components/shared/types";
import { getTabularReviewHistoryStatuses } from "@/app/lib/mikeApi";
import { notifyTabularReviewsChanged } from "@/app/lib/tabularReviewChanges";

type Status = "loading" | "complete";

export function useTabularHistoryStatuses(reviews: TabularReview[], activeReviewId: string | null) {
    const [statuses, setStatuses] = useState<Record<string, Status>>({});
    const activeRef = useRef(activeReviewId);
    useEffect(() => { activeRef.current = activeReviewId; }, [activeReviewId]);
    useEffect(() => {
        setStatuses(current => {
            const next = { ...current };
            for (const review of reviews) {
                if (review.is_running) next[review.id] = "loading";
                else if (current[review.id] === "loading") {
                    if (review.is_complete && review.id !== activeRef.current) next[review.id] = "complete";
                    else delete next[review.id];
                }
                if (review.id === activeRef.current && next[review.id] === "complete") delete next[review.id];
            }
            return Object.keys(next).length === Object.keys(current).length
                && Object.keys(next).every(id => next[id] === current[id]) ? current : next;
        });
    }, [reviews]);
    useEffect(() => {
        if (!activeReviewId) return;
        setStatuses(current => {
            if (current[activeReviewId] !== "complete") return current;
            const next = { ...current };
            delete next[activeReviewId];
            return next;
        });
    }, [activeReviewId]);

    // Poll only runs already observed in the authorized history, using small
    // status snapshots. Navigation detaches a review's stream, not its run.
    const runningKey = JSON.stringify(reviews.filter(review => statuses[review.id] === "loading").map(review => review.id));
    useEffect(() => {
        const ids: string[] = JSON.parse(runningKey);
        if (!ids.length) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const snapshots = [];
                for (let offset = 0; offset < ids.length; offset += 100) {
                    snapshots.push(...await getTabularReviewHistoryStatuses(ids.slice(offset, offset + 100), controller.signal));
                }
                if (controller.signal.aborted) return;
                const byId = new Map(snapshots.map(status => [status.id, status]));
                setStatuses(current => {
                    const next = { ...current };
                    for (const id of ids) {
                        const status = byId.get(id);
                        if (status?.is_running) next[id] = "loading";
                        else if (status?.is_complete && id !== activeRef.current) next[id] = "complete";
                        else delete next[id];
                    }
                    return next;
                });
                if (ids.some(id => !byId.get(id)?.is_running)) notifyTabularReviewsChanged();
            } catch {
                // A failed status check is not evidence of completion.
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
            }
        };
        timer = setTimeout(poll, 3000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [runningKey]);

    const clearStatus = useCallback((id: string) => {
        setStatuses(current => {
            if (current[id] !== "complete") return current;
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);
    return { statuses, clearStatus };
}
