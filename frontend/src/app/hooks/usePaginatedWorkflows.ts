import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { Workflow } from "@/app/components/shared/types";
import {
    listSystemWorkflows,
    listWorkflowIds,
    listWorkflowsPage,
} from "@/app/lib/mikeApi";
import { appendUniqueRows, paginationError, splitOverfetchedPage } from "@/app/lib/paginatedRows";

export type WorkflowSortKey = "name" | "type" | "created";
export type WorkflowSortDirection = "asc" | "desc";
export type WorkflowScope = "all" | "owned" | "shared";
type WorkflowTypeFilter = "assistant" | "tabular" | undefined;

const PAGE_SIZE = 30;

/**
 * Server-side-paginated owned+shared workflows, plus the always-eager,
 * always-fully-loaded static system-workflow bucket (37 entries, no
 * user-data growth — never paginated, fetched once). Cloned from
 * usePaginatedProjects/usePaginatedTabularReviews, adapted for this hybrid
 * two-source merge: the consumer is expected to concatenate `systemWorkflows`
 * (filtered/sorted entirely client-side, as before) with `dbWorkflows` (the
 * paginated, server-filtered/sorted portion) for display.
 *
 * Selection is deliberately NOT one uniform "select all matching" the way
 * Projects/Tabular Reviews have it: bulk Delete only ever applies to owned
 * DB rows (needs `selectAllMatchingOwned`, which may hit the network),
 * while bulk Hide/Unhide only ever applies to system rows (always fully in
 * memory already — the consumer can select those directly via
 * `setSelectedWorkflowIds` with no hook involvement needed).
 */
export function usePaginatedWorkflows(options: {
  dbEnabled?: boolean;
    systemEnabled?: boolean;
    type?: WorkflowTypeFilter;
    search?: string;
    selectionKey?: string;
    scope?: WorkflowScope;
    practiceFilter?: string | null;
    languageFilter?: string | null;
    jurisdictionFilter?: string | null;
    sort?: {
        key: WorkflowSortKey;
        direction: WorkflowSortDirection;
    } | null;
}) {
    const [systemWorkflows, setSystemWorkflows] = useState<Workflow[]>([]);
    const [systemLoading, setSystemLoading] = useState(true);

    const [dbWorkflows, setDbWorkflows] = useState<Workflow[]>([]);
    const [dbLoading, setDbLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
    const [selectingAllRequest, setSelectingAllRequest] = useState(false);
    const [retryVersion, setRetryVersion] = useState(0);
    const requestVersionRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const loadMoreControllerRef = useRef<AbortController | null>(null);

    const {
        type,
        search,
        selectionKey,
        scope = "all",
        practiceFilter = null,
        languageFilter = null,
        jurisdictionFilter = null,
        sort,
    dbEnabled = true,
    systemEnabled = true,
    } = options;
    const sortKey = sort?.key;
    const sortDirection = sort?.direction;
    const selectionQueryPending =
        selectionKey !== undefined && selectionKey !== search;
    const queryKey = JSON.stringify([
        type ?? null,
        selectionKey ?? null,
        search ?? null,
        scope,
        practiceFilter,
        languageFilter,
        jurisdictionFilter,
        sortKey ?? null,
        sortDirection ?? null,
    ]);
    const [selection, setSelection] = useState<{
        queryKey: string;
        ids: string[];
    }>({ queryKey, ids: [] });
    const selectedWorkflowIds =
        selection.queryKey === queryKey ? selection.ids : [];
    const setSelectedWorkflowIds: Dispatch<SetStateAction<string[]>> =
        useCallback(
            (value) => {
                setSelection((current) => {
          const currentIds = current.queryKey === queryKey ? current.ids : [];
          const ids = typeof value === "function" ? value(currentIds) : value;
                    return { queryKey, ids };
                });
            },
            [queryKey],
        );
    // System workflows: fetched once, never re-fetched on filter change —
    // there are only 37 of them and they never grow from user data.
    useEffect(() => {
        if (!systemEnabled) {
            setSystemWorkflows([]);
            setSystemLoading(false);
            return;
        }
        let cancelled = false;
        void listSystemWorkflows()
            .then((rows) => {
                if (!cancelled) setSystemWorkflows(rows);
            })
            .catch((error) => {
                if (cancelled) return;
                console.error("[workflows] failed to load system workflows", error);
                setSystemWorkflows([]);
            })
            .finally(() => {
                if (!cancelled) setSystemLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [systemEnabled]);

    useEffect(() => {
        const requestVersion = ++requestVersionRef.current;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
        setDbWorkflows([]);
        setHasMore(true);
        setLoadingMore(false);
        setError(null);
        setLoadMoreError(null);
    if (!dbEnabled) {
      setDbLoading(false);
      setHasMore(false);
      return;
    }
        setDbLoading(true);

        void listWorkflowsPage({
            limit: PAGE_SIZE + 1,
            type,
            search: search || undefined,
            scope,
            practice: practiceFilter || undefined,
            language: languageFilter || undefined,
            jurisdiction: jurisdictionFilter || undefined,
            sortKey,
            sortDirection,
            signal: controller.signal,
        })
            .then((rows) => {
                if (requestVersion !== requestVersionRef.current) return;
        const firstPage = splitOverfetchedPage(rows, PAGE_SIZE);
                setDbWorkflows(firstPage.rows);
                setHasMore(firstPage.hasMore);
            })
            .catch((error) => {
                if (
                    controller.signal.aborted ||
                    requestVersion !== requestVersionRef.current
                )
                    return;
                console.error("[workflows] failed to load", error);
        setError(paginationError(error, "Unable to load workflows"));
                setHasMore(false);
            })
            .finally(() => {
                if (
                    !controller.signal.aborted &&
                    requestVersion === requestVersionRef.current
                )
                    setDbLoading(false);
            });
        return () => {
            controller.abort();
            loadMoreControllerRef.current?.abort();
        };
    }, [
        type,
        retryVersion,
        scope,
        practiceFilter,
        languageFilter,
        jurisdictionFilter,
        search,
        sortDirection,
        sortKey,
    dbEnabled,
    ]);

    const loadMore = useCallback(async () => {
    if (!dbEnabled || dbLoading || loadingMoreRef.current || !hasMore) return;

        const requestVersion = requestVersionRef.current;
        const offset = dbWorkflows.length;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = controller;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError(null);

        try {
            const rows = await listWorkflowsPage({
                limit: PAGE_SIZE + 1,
                offset,
                type,
                search: search || undefined,
                scope,
                practice: practiceFilter || undefined,
                language: languageFilter || undefined,
                jurisdiction: jurisdictionFilter || undefined,
                sortKey,
                sortDirection,
                signal: controller.signal,
            });
            if (requestVersion !== requestVersionRef.current) return;

      const nextPage = splitOverfetchedPage(rows, PAGE_SIZE);
      setDbWorkflows((current) => appendUniqueRows(current, nextPage.rows));
            setHasMore(nextPage.hasMore);
        } catch (error) {
            if (
                !controller.signal.aborted &&
                requestVersion === requestVersionRef.current
            ) {
                console.error("[workflows] failed to load more", error);
        setLoadMoreError(paginationError(error, "Unable to load workflows"));
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
        dbLoading,
    dbEnabled,
        hasMore,
        type,
        dbWorkflows.length,
        scope,
        practiceFilter,
        languageFilter,
        jurisdictionFilter,
        search,
        sortDirection,
        sortKey,
    ]);
    const retry = useCallback(() => {
        setRetryVersion((current) => current + 1);
    }, []);

  const [selectAllOwners, setSelectAllOwners] = useState<{
    queryKey: string;
    ownerById: Record<string, string>;
  }>({ queryKey, ownerById: {} });
  const getWorkflowOwnerId = useCallback(
    (id: string): string | undefined => {
      const loaded = dbWorkflows.find((workflow) => workflow.id === id);
      if (loaded) return loaded.user_id ?? undefined;
      return selectAllOwners.queryKey === queryKey
        ? selectAllOwners.ownerById[id]
        : undefined;
    },
    [dbWorkflows, queryKey, selectAllOwners],
  );

  // Select every DB-backed workflow matching the active source scope and
  // filters. System workflow ids can be supplied by the caller because
  // that static bucket is already fully loaded in memory.
  const selectAllMatching = useCallback(
    async (
      additionalIds: string[] = [],
      selectionScope: WorkflowScope = scope,
    ) => {
        if (selectionQueryPending) return;

        if (!hasMore) {
            const selectableWorkflows =
              selectionScope === "owned"
                ? dbWorkflows.filter((workflow) => workflow.is_owner !== false)
                : selectionScope === "shared"
                  ? dbWorkflows.filter((workflow) => workflow.is_owner === false)
                  : dbWorkflows;
            setSelectedWorkflowIds(
          Array.from(
            new Set([
              ...additionalIds,
              ...selectableWorkflows.map((workflow) => workflow.id),
            ]),
          ),
            );
            return;
        }

        const requestVersion = requestVersionRef.current;
        setSelectingAllRequest(true);
        try {
            const rows = await listWorkflowIds({
                type,
                search: search || undefined,
          scope: selectionScope,
                practice: practiceFilter || undefined,
                language: languageFilter || undefined,
                jurisdiction: jurisdictionFilter || undefined,
            });
            if (requestVersion !== requestVersionRef.current) return;

        setSelectAllOwners({
          queryKey,
          ownerById: Object.fromEntries(
            rows.map((row) => [row.id, row.user_id]),
          ),
        });
        setSelectedWorkflowIds(
          Array.from(new Set([...additionalIds, ...rows.map((row) => row.id)])),
        );
        } catch (error) {
            // Call sites fire this with `void`, so without a catch a failed
            // id fetch is an unhandled rejection and the checkbox just
            // silently does nothing. Surface it the way loadMore does.
            if (requestVersion === requestVersionRef.current) {
                console.error(
                    "[workflows] failed to select all matching",
                    error,
                );
                setLoadMoreError(
                    paginationError(error, "Unable to select all workflows"),
                );
            }
        } finally {
            if (requestVersion === requestVersionRef.current) {
                setSelectingAllRequest(false);
            }
        }
    },
    [
        hasMore,
      queryKey,
        type,
        dbWorkflows,
      scope,
        practiceFilter,
        languageFilter,
        jurisdictionFilter,
        search,
        selectionQueryPending,
        setSelectedWorkflowIds,
    ],
  );

    return {
        systemWorkflows,
        dbWorkflows,
        setDbWorkflows,
        loading: systemLoading || dbLoading,
        loadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore,
        retry,
        selectedWorkflowIds,
        setSelectedWorkflowIds,
    selectAllMatching,
        selectingAll: selectingAllRequest || selectionQueryPending,
    getWorkflowOwnerId,
    };
}
