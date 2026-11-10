"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import {
    listPlaybookRunHistory,
    type PlaybookRunHistoryItem,
} from "@/app/lib/mikeApi";

const PAGE_SIZE = 25;
const MAX_REFRESH = 100;

/**
 * The caller's playbook runs in the active workspace, newest first, a page at
 * a time. A refresh reloads what is already shown, so rows stay in place.
 */
export function usePlaybookRunHistory() {
    const workspace = useWorkspaceParam();
    const [runs, setRuns] = useState<PlaybookRunHistoryItem[]>([]);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    // A newer request, or another workspace, makes an older answer stale.
    const version = useRef(0);
    const loaded = useRef<{ workspace: string; count: number } | null>(null);
    const loadingMoreRef = useRef(false);

    const refresh = useCallback(async () => {
        const request = ++version.current;
        const key = workspace ?? "";
        const same = loaded.current?.workspace === key;
        if (!same) {
            setRuns([]);
            setHasMore(true);
            setLoading(true);
        }
        const limit = Math.min(
            Math.max(same ? loaded.current!.count : 0, PAGE_SIZE),
            MAX_REFRESH,
        );
        try {
            const page = await listPlaybookRunHistory({ workspace, limit });
            if (request !== version.current) return;
            loaded.current = { workspace: key, count: page.length };
            setRuns(page);
            setHasMore(page.length === limit);
            setError(null);
        } catch (err) {
            if (request !== version.current) return;
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            if (request === version.current) setLoading(false);
        }
    }, [workspace]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const loadMore = useCallback(async () => {
        const last = runs.at(-1);
        if (!hasMore || loading || !last || loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        const request = version.current;
        try {
            const page = await listPlaybookRunHistory({
                workspace,
                before: last.startedAt,
                limit: PAGE_SIZE,
            });
            if (request !== version.current) return;
            setRuns((current) => {
                const seen = new Set(current.map((run) => run.id));
                const next = [
                    ...current,
                    ...page.filter((run) => !seen.has(run.id)),
                ];
                if (loaded.current) loaded.current.count = next.length;
                return next;
            });
            setHasMore(page.length === PAGE_SIZE);
        } catch (err) {
            if (request === version.current)
                setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            loadingMoreRef.current = false;
            setLoadingMore(false);
        }
    }, [hasMore, loading, runs, workspace]);

    return { runs, hasMore, loading, loadingMore, error, loadMore, refresh };
}
