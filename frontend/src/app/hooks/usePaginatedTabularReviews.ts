import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { TabularReview } from "@/app/components/shared/types";
import { listTabularReviewIds, listTabularReviews } from "@/app/lib/mikeApi";
import { appendUniqueRows, paginationError, splitOverfetchedPage } from "@/app/lib/paginatedRows";

export type TabularReviewSortKey = "name" | "columns" | "documents" | "created";
export type TabularReviewSortDirection = "asc" | "desc";
export type TabularReviewScope = "all" | "in-project" | "standalone";

const PAGE_SIZE = 30;

export function usePaginatedTabularReviews(options: {
    projectId?: string;
    search?: string;
    selectionKey?: string;
    scope?: TabularReviewScope;
    sort?: {
        key: TabularReviewSortKey;
        direction: TabularReviewSortDirection;
    } | null;
}) {
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
    const [selectingAllRequest, setSelectingAllRequest] = useState(false);
    const [retryVersion, setRetryVersion] = useState(0);
    const requestVersionRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const loadMoreControllerRef = useRef<AbortController | null>(null);

    const { projectId, search, selectionKey, scope = "all", sort } = options;
    const sortKey = sort?.key;
    const sortDirection = sort?.direction;
    const selectionQueryPending =
        selectionKey !== undefined && selectionKey !== search;
    const queryKey = JSON.stringify([
        projectId ?? null,
        selectionKey ?? null,
        search ?? null,
        scope,
        sortKey ?? null,
        sortDirection ?? null,
    ]);
    const [selection, setSelection] = useState<{
        queryKey: string;
        ids: string[];
    }>({ queryKey, ids: [] });
    const selectedReviewIds =
        selection.queryKey === queryKey ? selection.ids : [];
  const setSelectedReviewIds: Dispatch<SetStateAction<string[]>> = useCallback(
            (value) => {
                setSelection((current) => {
        const currentIds = current.queryKey === queryKey ? current.ids : [];
        const ids = typeof value === "function" ? value(currentIds) : value;
                    return { queryKey, ids };
                });
            },
            [queryKey],
        );
    // Owner lookup for review ids that "select all matching" pulled in but
    // that haven't been paged into `reviews` yet — bulk actions (e.g. delete)
    // need the owning user_id without fetching each review's full payload.
    const [selectAllOwners, setSelectAllOwners] = useState<{
        queryKey: string;
        ownerById: Record<string, string>;
    }>({ queryKey, ownerById: {} });
    const getReviewOwnerId = useCallback(
        (id: string): string | undefined => {
            const loaded = reviews.find((review) => review.id === id);
            if (loaded) return loaded.user_id;
            return selectAllOwners.queryKey === queryKey
                ? selectAllOwners.ownerById[id]
                : undefined;
        },
        [reviews, selectAllOwners, queryKey],
    );

    useEffect(() => {
        const requestVersion = ++requestVersionRef.current;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
        setReviews([]);
        setHasMore(true);
        setLoadingMore(false);
        setError(null);
        setLoadMoreError(null);
        setLoading(true);

        void listTabularReviews(projectId, {
            limit: PAGE_SIZE + 1,
            search: search || undefined,
            scope,
            sortKey,
            sortDirection,
            signal: controller.signal,
        })
            .then((rows) => {
                if (requestVersion !== requestVersionRef.current) return;
        const firstPage = splitOverfetchedPage(rows, PAGE_SIZE);
                setReviews(firstPage.rows);
                setHasMore(firstPage.hasMore);
            })
            .catch((error) => {
                if (
                    controller.signal.aborted ||
                    requestVersion !== requestVersionRef.current
                )
                    return;
                console.error("[tabular reviews] failed to load", error);
        setError(paginationError(error, "Unable to load tabular reviews"));
                setHasMore(false);
            })
            .finally(() => {
                if (
                    !controller.signal.aborted &&
                    requestVersion === requestVersionRef.current
                )
                    setLoading(false);
            });
        return () => {
            controller.abort();
            loadMoreControllerRef.current?.abort();
        };
    }, [projectId, retryVersion, scope, search, sortDirection, sortKey]);

    const loadMore = useCallback(async () => {
        if (loading || loadingMoreRef.current || !hasMore) return;

        const requestVersion = requestVersionRef.current;
        const offset = reviews.length;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = controller;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError(null);

        try {
            const rows = await listTabularReviews(projectId, {
                limit: PAGE_SIZE + 1,
                offset,
                search: search || undefined,
                scope,
                sortKey,
                sortDirection,
                signal: controller.signal,
            });
            if (requestVersion !== requestVersionRef.current) return;

      const nextPage = splitOverfetchedPage(rows, PAGE_SIZE);
      setReviews((current) => appendUniqueRows(current, nextPage.rows));
            setHasMore(nextPage.hasMore);
        } catch (error) {
            if (
                !controller.signal.aborted &&
                requestVersion === requestVersionRef.current
            ) {
                console.error("[tabular reviews] failed to load more", error);
        setLoadMoreError(
          paginationError(error, "Unable to load tabular reviews"),
        );
            }
        } finally {
            if (
                requestVersion === requestVersionRef.current &&
                loadMoreControllerRef.current === controller
            ) {
                loadMoreControllerRef.current = null;
                loadingMoreRef.current = false;
                setLoadingMore(false);
            }
        }
    }, [
        hasMore,
        loading,
        projectId,
        reviews.length,
        scope,
        search,
        sortDirection,
        sortKey,
    ]);
    const retry = useCallback(() => {
        setRetryVersion((current) => current + 1);
    }, []);

    // Selects every review matching the current filters, not just the page(s)
    // already loaded — a plain "select loaded rows" checkbox is misleading
    // once results span more than one page. Fetches only ids (+ owner), not
    // full review payloads, since that's all a bulk selection needs.
    const selectAllMatching = useCallback(async () => {
        if (selectionQueryPending) return;

        if (!hasMore) {
            setSelectedReviewIds(reviews.map((review) => review.id));
            return;
        }

        const requestVersion = requestVersionRef.current;
        setSelectingAllRequest(true);
        try {
            const rows = await listTabularReviewIds(projectId, {
                search: search || undefined,
                scope,
            });
            if (requestVersion !== requestVersionRef.current) return;

            setSelectAllOwners({
                queryKey,
        ownerById: Object.fromEntries(rows.map((row) => [row.id, row.user_id])),
            });
            setSelectedReviewIds(rows.map((row) => row.id));
        } catch (error) {
            // Call sites fire this with `void`, so without a catch a failed
            // id fetch is an unhandled rejection and the checkbox just
            // silently does nothing. Surface it the way loadMore does.
            if (requestVersion === requestVersionRef.current) {
                console.error(
                    "[tabular reviews] failed to select all matching",
                    error,
                );
                setLoadMoreError(
                    paginationError(
                        error,
                        "Unable to select all tabular reviews",
                    ),
                );
            }
        } finally {
            if (requestVersion === requestVersionRef.current) {
                setSelectingAllRequest(false);
            }
        }
    }, [
        hasMore,
        projectId,
        queryKey,
        reviews,
        scope,
        search,
        selectionQueryPending,
        setSelectedReviewIds,
    ]);

    return {
        reviews,
        setReviews,
        loading,
        loadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore,
        retry,
        selectedReviewIds,
        setSelectedReviewIds,
        selectAllMatching,
        selectingAll: selectingAllRequest || selectionQueryPending,
        getReviewOwnerId,
    };
}
