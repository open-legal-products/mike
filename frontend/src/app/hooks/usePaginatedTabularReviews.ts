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
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";

export type TabularReviewSortKey = "name" | "columns" | "documents" | "created" | "updated";
export type TabularReviewSortDirection = "asc" | "desc";
export type TabularReviewScope = "all" | "in-project" | "standalone";

const PAGE_SIZE = 30;

export function usePaginatedTabularReviews(options: {
    projectId?: string;
    /** Overview project filters must still stay within the active workspace. */
    scopeToWorkspace?: boolean;
    search?: string;
    selectionKey?: string;
    scope?: TabularReviewScope;
    includeStatus?: boolean;
    /** Keep loaded pages visible when refreshing the same query. */
    retainOnRefresh?: boolean;
    /** Only reviews this user created. */
    ownerUserId?: string | null;
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
    // Select-all owns its own counter. requestVersionRef tracks the list
    // query, and a search/scope/sort change bumps it while an ids request is
    // still in flight — gating the "done" flag on that version left the
    // header checkbox disabled until the next full reload.
    const selectAllRequestRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const loadMoreControllerRef = useRef<AbortController | null>(null);
    const loadedQueryRef = useRef<string | null>(null);
    const loadedPagesRef = useRef(1);
    const refreshingRef = useRef(false);

    const { projectId, search, selectionKey, scope = "all", sort, includeStatus, retainOnRefresh = false } = options;
    const ownerUserId = options.ownerUserId ?? undefined;
    // A project's own review list is already scoped by the project, which may
    // sit in a different workspace from the active one when it is opened by
    // link. Only the cross-project list follows the active workspace.
    const activeWorkspace = useWorkspaceParam();
    const workspace = (options.scopeToWorkspace ?? !projectId) ? activeWorkspace : undefined;
    const sortKey = sort?.key;
    const sortDirection = sort?.direction;
    const selectionQueryPending =
        selectionKey !== undefined && selectionKey !== search;
    const queryKey = JSON.stringify([
        projectId ?? null,
        selectionKey ?? null,
        search ?? null,
        workspace ?? null,
        scope,
        sortKey ?? null,
        sortDirection ?? null,
        ownerUserId ?? null,
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
        const requestKey = JSON.stringify([
            projectId, search, workspace, scope, ownerUserId, sortKey, sortDirection, includeStatus,
        ]);
        const retainRows = retainOnRefresh && loadedQueryRef.current === requestKey;
        const pageCount = retainRows ? loadedPagesRef.current : 1;
        const requestVersion = ++requestVersionRef.current;
        refreshingRef.current = true;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
        if (!retainRows) {
            loadedQueryRef.current = null;
            loadedPagesRef.current = 1;
            setReviews([]);
            setHasMore(true);
        }
        setLoadingMore(false);
        setError(null);
        setLoadMoreError(null);
        setLoading(!retainRows);

        // Status/activity refreshes replace the loaded range atomically. Keep
        // every loaded page so a completion cannot reset History's scroll range.
        void (async () => {
            let refreshed: TabularReview[] = [];
            let more = false;
            let pages = 0;
            for (; pages < pageCount;) {
                const rows = await listTabularReviews(projectId, {
                    includeStatus,
                    limit: PAGE_SIZE + 1,
                    offset: pages ? pages * PAGE_SIZE : undefined,
                    search: search || undefined,
                    workspace,
                    scope,
                    ownerUserId,
                    sortKey,
                    sortDirection,
                    signal: controller.signal,
                });
                if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return;
                const page = splitOverfetchedPage(rows, PAGE_SIZE);
                refreshed = appendUniqueRows(refreshed, page.rows);
                more = page.hasMore;
                pages += 1;
                if (!more) break;
            }
            loadedQueryRef.current = requestKey;
            loadedPagesRef.current = pages;
            setReviews(refreshed);
            setHasMore(more);
        })()
            .catch((error) => {
                if (
                    controller.signal.aborted ||
                    requestVersion !== requestVersionRef.current
                )
                    return;
                console.error("[tabular reviews] failed to load", error);
        setError(paginationError(error, "Unable to load tabular reviews"));
                if (!retainRows) setHasMore(false);
            })
            .finally(() => {
                if (
                    !controller.signal.aborted &&
                    requestVersion === requestVersionRef.current
                ) {
                    refreshingRef.current = false;
                    setLoading(false);
                }
            });
        return () => {
            controller.abort();
            loadMoreControllerRef.current?.abort();
        };
    }, [
        projectId,
        retryVersion,
        retainOnRefresh,
        includeStatus,
        ownerUserId,
        scope,
        search,
        sortDirection,
        sortKey,
        workspace,
    ]);

    const loadMore = useCallback(async () => {
        if (loading || refreshingRef.current || loadingMoreRef.current || !hasMore) return;

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
                includeStatus,
                limit: PAGE_SIZE + 1,
                offset,
                search: search || undefined,
                workspace,
                scope,
                ownerUserId,
                sortKey,
                sortDirection,
                signal: controller.signal,
            });
            if (requestVersion !== requestVersionRef.current) return;

      const nextPage = splitOverfetchedPage(rows, PAGE_SIZE);
      loadedPagesRef.current += 1;
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
        includeStatus,
        loading,
        ownerUserId,
        projectId,
        reviews.length,
        scope,
        search,
        workspace,
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
        const selectAllRequest = ++selectAllRequestRef.current;
        setSelectingAllRequest(true);
        try {
            const rows = await listTabularReviewIds(projectId, {
                search: search || undefined,
                workspace,
                scope,
                ownerUserId,
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
            // Clear for the request that set the flag, whatever the list
            // query has moved on to meanwhile. A newer select-all owns the
            // flag instead.
            if (selectAllRequest === selectAllRequestRef.current) {
                setSelectingAllRequest(false);
            }
        }
    }, [
        hasMore,
        ownerUserId,
        projectId,
        queryKey,
        reviews,
        scope,
        search,
        workspace,
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
