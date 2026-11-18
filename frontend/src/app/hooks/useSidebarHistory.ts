"use client";

import { useEffect, useMemo } from "react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { mergeSidebarHistory } from "@/app/lib/sidebarHistory";
import { subscribeTabularReviewChanges } from "@/app/lib/tabularReviewChanges";
import { subscribePlaybookRunChanges } from "@/app/lib/playbookRunActivity";
import { usePaginatedTabularReviews } from "./usePaginatedTabularReviews";
import { usePlaybookRunHistory } from "./usePlaybookRunHistory";

export function useSidebarHistory() {
    const { chats, hasMoreChats, loadingMoreChats, loadMoreChats } = useChatHistoryContext();
    const reviews = usePaginatedTabularReviews({
        scope: "all",
        includeStatus: true,
        retainOnRefresh: true,
        sort: { key: "updated", direction: "desc" },
    });
    const { reviews: loaded, retry, setReviews } = reviews;
    useEffect(() => subscribeTabularReviewChanges(statuses => {
        // Membership changes and older-server snapshots require an authorized list read.
        // A promotion within the loaded range cannot displace an unseen review.
        if (!statuses || statuses.some(status => {
            const existing = loaded.find(row => row.id === status.id);
            if (!existing || !status.updated_at) return true;
            if ((status.project_id !== undefined && status.project_id !== (existing.project_id ?? null)) ||
                (status.org_id !== undefined && status.org_id !== (existing.org_id ?? null))) return true;
            if (status.updated_at === existing.updated_at) return false;
            // A changed activity time may also accompany a rename or move.
            return Date.parse(status.updated_at) < Date.parse(existing.updated_at) ||
                status.title === undefined || status.project_id === undefined || status.org_id === undefined;
        })) {
            retry();
            return;
        }
        const byId = new Map(statuses.map(status => [status.id, status]));
        setReviews(current => current.map(row => {
            const status = byId.get(row.id);
            return status ? { ...row, ...status, updated_at: status.updated_at ?? row.updated_at } : row;
        }));
    }), [loaded, retry, setReviews]);
    const runs = usePlaybookRunHistory();
    const refreshRuns = runs.refresh;
    useEffect(
        () => subscribePlaybookRunChanges(() => void refreshRuns()),
        [refreshRuns],
    );
    const items = useMemo(() => mergeSidebarHistory(
        chats ?? [], reviews.reviews, hasMoreChats, reviews.hasMore,
        // Runs that could not load leave the rest of History in place.
        runs.error ? [] : runs.runs, !runs.error && runs.hasMore,
    ), [chats, hasMoreChats, reviews.reviews, reviews.hasMore, runs.runs, runs.hasMore, runs.error]);

    return {
        items,
        reviews: reviews.reviews,
        playbookRuns: runs.runs,
        loading: chats === null || reviews.loading || runs.loading,
        loadingMore: loadingMoreChats || reviews.loadingMore || runs.loadingMore,
        hasMore: hasMoreChats || reviews.hasMore || (!runs.error && runs.hasMore),
        error: reviews.error || reviews.loadMoreError || runs.error,
        retry: reviews.error
            ? reviews.retry
            : reviews.loadMoreError
              ? reviews.loadMore
              : runs.refresh,
        loadMore: async () => {
            await Promise.all([loadMoreChats(), reviews.loadMore(), runs.loadMore()]);
        },
    };
}
