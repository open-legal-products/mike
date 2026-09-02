"use client";

import type { Dispatch, SetStateAction } from "react";
import { Loader2 } from "lucide-react";
import { can, roleFrom } from "@/app/lib/permissions";
import type { OwnerGate } from "@/app/components/projects/ProjectWorkspace";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableFilters,
    type TableFilterOption,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    rowActionSelectionIds,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import type { Document, TabularReview } from "@/app/components/shared/types";
import { formatDate } from "./ProjectPageParts";
import type {
    TabularReviewSortDirection,
    TabularReviewSortKey,
} from "@/app/hooks/usePaginatedTabularReviews";

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];

export function ProjectReviewsTable({
    docs,
    reviews,
    selectedReviewIds,
    creatingReview,
    onCreateReview,
    onOpenReview,
    onOpenDetails,
    onDeleteReview,
    onDeleteSelectedReviews,
    onOwnerOnlyAction,
    setSelectedReviewIds,
    onToggleAll,
    selectingAll = false,
    deletingReviewIds,
    hasActiveSearch,
    sort,
    onSortChange,
    hasMore,
    loadingMore,
    error,
    loadMoreError,
    onLoadMore,
    onRetry,
    loading = false,
}: {
    docs: Document[];
    reviews: TabularReview[];
    selectedReviewIds: string[];
    creatingReview: boolean;
    onCreateReview: () => void;
    onOpenReview: (reviewId: string) => void;
    onOpenDetails: (review: TabularReview) => void;
    onDeleteReview: (review: TabularReview) => Promise<void> | void;
    onDeleteSelectedReviews: () => Promise<void> | void;
    onOwnerOnlyAction: (gate: OwnerGate) => void;
    setSelectedReviewIds: Dispatch<SetStateAction<string[]>>;
    onToggleAll: () => void;
    selectingAll?: boolean;
    deletingReviewIds: ReadonlySet<string>;
    hasActiveSearch: boolean;
    sort: {
        key: TabularReviewSortKey;
        direction: TabularReviewSortDirection;
    } | null;
    onSortChange: (
        key: TabularReviewSortKey,
        direction: TableSortDirection | null,
    ) => void;
    hasMore: boolean;
    loadingMore: boolean;
    error: Error | null;
    loadMoreError: Error | null;
    onLoadMore: () => void;
    onRetry: () => void;
    loading?: boolean;
}) {
    function clearSelection() {
        setSelectedReviewIds([]);
    }

    function handleSortChange(
        key: TabularReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        onSortChange(key, direction);
        clearSelection();
    }

    const visibleReviews = reviews;

    const allVisibleReviewsSelected =
        visibleReviews.length > 0 &&
        visibleReviews.every((review) => selectedReviewIds.includes(review.id));
    const someVisibleReviewsSelected =
        !allVisibleReviewsSelected &&
        visibleReviews.some((review) => selectedReviewIds.includes(review.id));
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const columnsSortDirection =
        sort?.key === "columns" ? sort.direction : null;
    const documentsSortDirection =
        sort?.key === "documents" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const nameFilterButton = (
        <TableFilters
            label="Sort by review name"
            value={nameSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            align="right"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const columnsFilterButton = (
        <TableFilters
            label="Sort by columns"
            value={columnsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("columns", direction)}
        />
    );
    const documentsFilterButton = (
        <TableFilters
            label="Sort by documents"
            value={documentsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("documents", direction)}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label="Sort by created date"
            value={createdSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    return (
        <TableScrollArea
            onScroll={(event) => {
                if (loading || loadingMore || !hasMore) return;
                const element = event.currentTarget;
                const distanceToBottom =
                    element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight;
                if (distanceToBottom < 200) onLoadMore();
            }}
            header={
                <TableHeaderRow className="pr-8 md:pr-8">
                    <TableStickyCell header>
                        {loading ? (
                            <SkeletonCheckbox />
                        ) : (
                            <input
                                type="checkbox"
                                checked={allVisibleReviewsSelected}
                                disabled={
                                    selectingAll || deletingReviewIds.size > 0
                                }
                                ref={(el) => {
                                    if (el)
                                        el.indeterminate =
                                            someVisibleReviewsSelected;
                                }}
                                onChange={onToggleAll}
                                className={TABLE_CHECKBOX_CLASS}
                            />
                        )}
                        <span className="mr-1">Name</span>
                        {!loading && nameFilterButton}
                    </TableStickyCell>
                    <TableHeaderCell className="ml-auto w-24">
                        <div className="flex items-center gap-1">
                            <span>Columns</span>
                            {!loading && columnsFilterButton}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-24">
                        <div className="flex items-center gap-1">
                            <span>Documents</span>
                            {!loading && documentsFilterButton}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-32">
                        <div className="flex items-center gap-1">
                            <span>Created</span>
                            {!loading && createdFilterButton}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-8" />
                </TableHeaderRow>
            }
        >
            {loading ? (
                <ProjectReviewsLoadingRows />
            ) : error ? (
                <TableEmptyState>
                    <p className="text-lg font-medium font-serif text-gray-900">
                        Unable to load reviews
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                        Check your connection and try again.
                    </p>
                    <PillButton
                        tone="black"
                        size="sm"
                        onClick={onRetry}
                        className="mt-4 px-3"
                    >
                        Try again
                    </PillButton>
                </TableEmptyState>
            ) : reviews.length === 0 ? (
                <TableEmptyState>
                    {hasActiveSearch ? (
                        <p className="text-sm text-gray-400">
                            No reviews found
                        </p>
                    ) : (
                        <EmptyState
                            icon={<TabularReviewSkeuoIcon />}
                            title="Tabular Reviews"
                            description="Extract data from project documents into tables using AI."
                            action={
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={onCreateReview}
                                    disabled={
                                        creatingReview || docs.length === 0
                                    }
                                    className="px-3"
                                >
                                    Create
                                </PillButton>
                            }
                        />
                    )}
                </TableEmptyState>
            ) : (
                <TableBody>
                    {visibleReviews.map((review) => {
                        const deleting = deletingReviewIds.has(review.id);
                        const actionIds = rowActionSelectionIds(
                            review.id,
                            selectedReviewIds,
                        );
                        const appliesToSelection = actionIds.length > 1;
                        return (
                            <TableRow
                                key={review.id}
                                interactive={!deleting}
                                selected={
                                    !deleting &&
                                    selectedReviewIds.includes(review.id)
                                }
                                rightClickDropdown={
                                    deleting
                                        ? undefined
                                        : (close, menuProps) => (
                                              <RowActionMenuItems
                                                  onClose={close}
                                                  surfaceProps={menuProps}
                                                  onView={
                                                      appliesToSelection
                                                          ? undefined
                                                          : () =>
                                                                onOpenReview(
                                                                    review.id,
                                                                )
                                                  }
                                                  viewLabel="Open"
                                                  onEditDetails={
                                                      appliesToSelection
                                                          ? undefined
                                                          : () => {
                                                                if (
                                                                    !can(
                                                                        roleFrom(
                                                                            review,
                                                                        ),
                                                                        "content.edit",
                                                                    )
                                                                ) {
                                                                    onOwnerOnlyAction(
                                                                        {
                                                                            action: "edit tabular review details",
                                                                            requiredRole:
                                                                                "member",
                                                                        },
                                                                    );
                                                                    return;
                                                                }
                                                                onOpenDetails(review);
                                                            }
                                                  }
                                                  onDelete={() =>
                                                      appliesToSelection
                                                          ? onDeleteSelectedReviews()
                                                          : onDeleteReview(review)
                                                  }
                                                  deleteLabel={
                                                      appliesToSelection
                                                          ? `Delete ${actionIds.length} reviews`
                                                          : undefined
                                                  }
                                              />
                                          )
                                }
                                onClick={
                                    deleting
                                        ? undefined
                                        : () => onOpenReview(review.id)
                                }
                                className={
                                    deleting
                                        ? "pointer-events-none pr-8 opacity-50 md:pr-8"
                                        : "pr-8 md:pr-8"
                                }
                            >
                                <TablePrimaryCell
                                    selected={
                                        !deleting &&
                                        selectedReviewIds.includes(review.id)
                                    }
                                    selectionIndicator={
                                        deleting ? (
                                            <Loader2 className="mr-4 h-3 w-3 shrink-0 animate-spin text-gray-400" />
                                        ) : undefined
                                    }
                                    onSelectionChange={() =>
                                        setSelectedReviewIds((prev) =>
                                            prev.includes(review.id)
                                                ? prev.filter(
                                                      (x) => x !== review.id,
                                                  )
                                                : [...prev, review.id],
                                        )
                                    }
                                    label={review.title ?? "Untitled Review"}
                                />
                                <TableCell className="ml-auto w-24">
                                    {review.columns_config?.length ?? 0}
                                </TableCell>
                                <TableCell className="w-24">
                                    {review.document_count ?? 0}
                                </TableCell>
                                <TableCell className="w-32">
                                    {review.created_at ? (
                                        formatDate(review.created_at)
                                    ) : (
                                        <span className="text-gray-300">—</span>
                                    )}
                                </TableCell>
                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <RowActions
                                        onView={() =>
                                            onOpenReview(review.id)
                                        }
                                        viewLabel="Open"
                                        onEditDetails={() => {
                                            if (
                                                !can(
                                                    roleFrom(review),
                                                    "content.edit",
                                                )
                                            ) {
                                                onOwnerOnlyAction({
                                                    action: "edit tabular review details",
                                                    requiredRole: "member",
                                                });
                                                return;
                                            }
                                            onOpenDetails(review);
                                        }}
                                        onDelete={() => onDeleteReview(review)}
                                    />
                                </div>
                            </TableRow>
                        );
                    })}
                </TableBody>
            )}
            <TableLoadMoreRow
                loading={loading}
                hasMore={hasMore}
                itemCount={reviews.length}
                loadingMore={loadingMore}
                hasError={!!loadMoreError}
                onLoadMore={onLoadMore}
            />
        </TableScrollArea>
    );
}

function ProjectReviewsLoadingRows() {
    const titleWidths = ["w-36", "w-40", "w-44", "w-48", "w-52"];

    return (
        <TableBody>
            {[1, 2, 3, 4, 5].map((i) => (
                <TableRow key={i} interactive={false} className="pr-8 md:pr-8">
                    <TableStickyCell hover={false}>
                        <div className="flex min-w-0 items-center">
                            <SkeletonCheckbox />
                            <SkeletonLine
                                className={`h-3.5 ${titleWidths[i - 1]}`}
                            />
                        </div>
                    </TableStickyCell>
                    <TableCell className="ml-auto w-24">
                        <SkeletonLine className="w-8" />
                    </TableCell>
                    <TableCell className="w-24">
                        <SkeletonLine className="w-8" />
                    </TableCell>
                    <TableCell className="w-32">
                        <SkeletonLine className="w-20" />
                    </TableCell>
                    <TableCell className="w-8" />
                </TableRow>
            ))}
        </TableBody>
    );
}
