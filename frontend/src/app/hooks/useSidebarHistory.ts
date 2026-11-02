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
    useEffect(() => subscribeTabularReviewChanges(reviews.retry), [reviews.retry]);
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
