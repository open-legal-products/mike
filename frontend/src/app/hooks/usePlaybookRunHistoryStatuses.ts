"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    getPlaybookRunStatuses,
    type PlaybookRunHistoryItem,
} from "@/app/lib/mikeApi";
import { notifyPlaybookRunsChanged } from "@/app/lib/playbookRunActivity";

type Status = "loading" | "complete";

/**
 * History's spinner and tick for playbook runs, as for tabular reviews: a run
 * shows a spinner while it runs, even after leaving its page, and a tick once
 * it finishes until its results are viewed. A failed run gets no tick.
 */
export function usePlaybookRunHistoryStatuses(
    runs: PlaybookRunHistoryItem[],
    viewedRunId: string | null,
) {
    const [statuses, setStatuses] = useState<Record<string, Status>>({});
    const viewedRef = useRef(viewedRunId);
    useEffect(() => {
        viewedRef.current = viewedRunId;
    }, [viewedRunId]);

    useEffect(() => {
        setStatuses((current) => {
            const next = { ...current };
            for (const run of runs) {
                if (run.status === "running") next[run.id] = "loading";
                else if (current[run.id] === "loading") {
                    if (
                        run.status === "completed" &&
                        run.id !== viewedRef.current
                    )
                        next[run.id] = "complete";
                    else delete next[run.id];
                }
            }
            return sameStatuses(current, next) ? current : next;
        });
    }, [runs]);

    // Viewing a run's results is what clears its tick.
    useEffect(() => {
        if (!viewedRunId) return;
        setStatuses((current) => {
            if (current[viewedRunId] !== "complete") return current;
            const next = { ...current };
            delete next[viewedRunId];
            return next;
        });
    }, [viewedRunId]);

    // Poll only runs already seen running, with small status snapshots. The
    // review runs on the server whether or not its page is open.
    const runningKey = JSON.stringify(
        runs.filter((run) => statuses[run.id] === "loading").map((run) => run.id),
    );
    useEffect(() => {
        const ids: string[] = JSON.parse(runningKey);
        if (!ids.length) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const snapshots = await getPlaybookRunStatuses(
                    ids.slice(0, 100),
                    controller.signal,
                );
                if (controller.signal.aborted) return;
                const byId = new Map(snapshots.map((run) => [run.id, run]));
                setStatuses((current) => {
                    const next = { ...current };
                    for (const id of ids) {
                        const status = byId.get(id)?.status;
                        if (status === "running") next[id] = "loading";
                        else if (
                            status === "completed" &&
                            id !== viewedRef.current
                        )
                            next[id] = "complete";
                        else delete next[id];
                    }
                    return next;
                });
                if (ids.some((id) => byId.get(id)?.status !== "running"))
                    notifyPlaybookRunsChanged();
            } catch {
                // A failed status check is not evidence of completion.
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
            }
        };
        timer = setTimeout(poll, 3000);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [runningKey]);

    const clearStatus = useCallback((id: string) => {
        setStatuses((current) => {
            if (current[id] !== "complete") return current;
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);
    return { statuses, clearStatus };
}

function sameStatuses(a: Record<string, Status>, b: Record<string, Status>) {
    const keys = Object.keys(b);
    return (
        keys.length === Object.keys(a).length &&
        keys.every((key) => a[key] === b[key])
    );
}
