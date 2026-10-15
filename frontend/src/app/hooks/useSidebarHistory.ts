"use client";

import { useEffect, useMemo } from "react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { mergeSidebarHistory } from "@/app/lib/sidebarHistory";
import { subscribeTabularReviewChanges } from "@/app/lib/tabularReviewChanges";
import { usePaginatedTabularReviews } from "./usePaginatedTabularReviews";

export function useSidebarHistory() {
    const { chats, hasMoreChats, loadingMoreChats, loadMoreChats } = useChatHistoryContext();
    const reviews = usePaginatedTabularReviews({
        scope: "all",
        includeStatus: true,
        retainOnRefresh: true,
        sort: { key: "updated", direction: "desc" },
    });
    useEffect(() => subscribeTabularReviewChanges(reviews.retry), [reviews.retry]);
    const items = useMemo(() => mergeSidebarHistory(
        chats ?? [], reviews.reviews, hasMoreChats, reviews.hasMore,
    ), [chats, hasMoreChats, reviews.reviews, reviews.hasMore]);

    return {
        items,
        reviews: reviews.reviews,
        loading: chats === null || reviews.loading,
        loadingMore: loadingMoreChats || reviews.loadingMore,
        hasMore: hasMoreChats || reviews.hasMore,
        error: reviews.error || reviews.loadMoreError,
        retry: reviews.error ? reviews.retry : reviews.loadMore,
        loadMore: async () => {
            await Promise.all([loadMoreChats(), reviews.loadMore()]);
        },
    };
}
