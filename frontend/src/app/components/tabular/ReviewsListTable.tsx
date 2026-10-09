"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Loader2 } from "lucide-react";
import { can, roleFrom } from "@/app/lib/permissions";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
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
    TableSortFilter,
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
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import type { Project, TabularReview } from "@/app/components/shared/types";
import { formatDate } from "@/app/components/projects/ProjectPageParts";
import type {
    TabularReviewSortDirection,
    TabularReviewSortKey,
} from "@/app/hooks/usePaginatedTabularReviews";

/**
 * The tabular reviews list. Pass `projectColumn` on surfaces that list reviews
 * across projects; a single project's list omits it.
 */
export function ReviewsListTable({
    reviews,
    selectedReviewIds,
    createDisabled,
    emptyDescription,
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
    hasActiveFilters,
    projectColumn,
    rowClassName,
    sort,
    onSortChange,
    hasMore,
    loadingMore,
    error,
    loadMoreError,
    onLoadMore,
    onRetry,
    loading = false,
    renderToolbar,
}: {
    reviews: TabularReview[];
    selectedReviewIds: string[];
    createDisabled: boolean;
    emptyDescription: string;
    onCreateReview: () => void;
    onOpenReview: (review: TabularReview) => void;
    onOpenDetails: (review: TabularReview) => void;
    onDeleteReview: (review: TabularReview) => Promise<void> | void;
    onDeleteSelectedReviews: () => Promise<void> | void;
    onOwnerOnlyAction: (
        gate: { action: string; requiredRole: "owner" | "editor" },
        review: TabularReview,
    ) => void;
    setSelectedReviewIds: Dispatch<SetStateAction<string[]>>;
    onToggleAll: () => void;
    selectingAll?: boolean;
    deletingReviewIds: ReadonlySet<string>;
    /** A search, scope or filter is narrowing the list. */
    hasActiveFilters: boolean;
    projectColumn?: {
        projects: Project[];
        filter: string | null;
        onFilterChange: (projectId: string | null) => void;
    };
    /** Applied to the header and every row, for the host's gutter. */
    rowClassName?: string;
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
    renderToolbar?: (actions: ReactNode) => ReactNode;
}) {
    function clearSelection() {
        setSelectedReviewIds([]);
    }

    function requestReviewDetails(review: TabularReview) {
        if (!can(roleFrom(review), "content.edit")) {
            onOwnerOnlyAction({ action: "edit tabular review details", requiredRole: "editor" }, review);
            return;
        }
        onOpenDetails(review);
    }

    function renderReviewActions(review: TabularReview | undefined, onClose: () => void) {
        const actionIds = review
            ? rowActionSelectionIds(review.id, selectedReviewIds)
            : selectedReviewIds;
        const appliesToSelection = actionIds.length > 1;
        return (
            <RowActionMenuItems
                onClose={onClose}
                onView={!appliesToSelection && review ? () => onOpenReview(review) : undefined}
                viewLabel="Open"
                onEditDetails={!appliesToSelection && review ? () => requestReviewDetails(review) : undefined}
                onDelete={() =>
                    appliesToSelection || !review
                        ? onDeleteSelectedReviews()
                        : onDeleteReview(review)
                }
                deleteLabel={appliesToSelection ? `Delete ${actionIds.length} reviews` : undefined}
            />
        );
    }

    function handleSortChange(
        key: TabularReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        onSortChange(key, direction);
        clearSelection();
    }

    const allVisibleReviewsSelected =
        reviews.length > 0 &&
        reviews.every((review) => selectedReviewIds.includes(review.id));
    const someVisibleReviewsSelected =
        !allVisibleReviewsSelected &&
        reviews.some((review) => selectedReviewIds.includes(review.id));
    const projectNameById = new Map(
        projectColumn?.projects.map((project) => [project.id, project.name]),
    );
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const columnsSortDirection =
        sort?.key === "columns" ? sort.direction : null;
    const documentsSortDirection =
        sort?.key === "documents" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const nameFilterButton = (
        <TableSortFilter
            label="Sort by review name"
            value={nameSortDirection}
            align="right"
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const columnsFilterButton = (
        <TableSortFilter
            label="Sort by columns"
            value={columnsSortDirection}
            onChange={(direction) => handleSortChange("columns", direction)}
        />
    );
    const documentsFilterButton = (
        <TableSortFilter
            label="Sort by documents"
            value={documentsSortDirection}
            onChange={(direction) => handleSortChange("documents", direction)}
        />
    );
    const createdFilterButton = (
        <TableSortFilter
            label="Sort by created date"
            value={createdSortDirection}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    return (
        <>
        {renderToolbar?.(selectedReviewIds.length > 0 ? (
            <SelectionActionsMenu
                renderItems={(close) => renderReviewActions(reviews.find((review) => review.id === selectedReviewIds[0]), close)}
            />
        ) : undefined)}
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
                <TableHeaderRow className={rowClassName}>
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
                                aria-label="Select all reviews"
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
                    {projectColumn && (
                        <TableHeaderCell className="w-52">
                            <div className="flex items-center gap-1">
                                <span>Project</span>
                                {!loading && (
                                    <TableFilters
                                        label="Filter by project"
                                        value={projectColumn.filter}
                                        allLabel="All Projects"
                                        options={projectColumn.projects.map(
                                            (project) => ({
                                                value: project.id,
                                                label: project.name,
                                            }),
                                        )}
                                        onChange={projectColumn.onFilterChange}
                                    />
                                )}
                            </div>
                        </TableHeaderCell>
                    )}
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
                <ReviewsLoadingRows
                    showProject={!!projectColumn}
                    rowClassName={rowClassName}
                />
            ) : error ? (
                <TableEmptyState>
                    <p className="text-lg font-medium font-serif text-gray-900">
                        Unable to load reviews
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                        Check your connection and try again.
                    </p>
                    <PillButtonUI
                        tone="black"
                        size="sm"
                        onClick={onRetry}
                        className="mt-4"
                    >
                        Try again
                    </PillButtonUI>
                </TableEmptyState>
            ) : reviews.length === 0 ? (
                <TableEmptyState>
                    {hasActiveFilters ? (
                        <p className="text-sm text-gray-400">
                            No reviews found
                        </p>
                    ) : (
                        <EmptyState
                            icon={<TabularReviewSkeuoIcon />}
                            title="Tabular Reviews"
                            description={emptyDescription}
                            action={
                                <PillButtonUI
                                    tone="black"
                                    size="sm"
                                    onClick={onCreateReview}
                                    disabled={createDisabled}
                                >
                                    Create
                                </PillButtonUI>
                            }
                        />
                    )}
                </TableEmptyState>
            ) : (
                <TableBody>
                    {reviews.map((review) => {
                        const deleting = deletingReviewIds.has(review.id);
                        return (
                            <TableRow
                                key={review.id}
                                interactive={!deleting}
                                selected={
                                    !deleting &&
                                    selectedReviewIds.includes(review.id)
                                }
                                rightClickDropdown={deleting ? undefined : (close) => renderReviewActions(review, close)}
                                onClick={
                                    deleting
                                        ? undefined
                                        : () => onOpenReview(review)
                                }
                                className={cn(
                                    rowClassName,
                                    deleting &&
                                        "pointer-events-none opacity-50",
                                )}
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
                                {projectColumn && (
                                    <TableCell className="w-52 pr-2">
                                        {(review.project_id &&
                                            projectNameById.get(
                                                review.project_id,
                                            )) || (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                )}
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
                                        onView={() => onOpenReview(review)}
                                        viewLabel="Open"
                                        onEditDetails={() => requestReviewDetails(review)}
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
        </>
    );
}

function ReviewsLoadingRows({
    showProject,
    rowClassName,
}: {
    showProject: boolean;
    rowClassName?: string;
}) {
    const titleWidths = ["w-36", "w-40", "w-44", "w-48", "w-52"];

    return (
        <TableBody>
            {[1, 2, 3, 4, 5].map((i) => (
                <TableRow key={i} interactive={false} className={rowClassName}>
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
                    {showProject && (
                        <TableCell className="w-52">
                            <SkeletonLine className="w-24" />
                        </TableCell>
                    )}
                    <TableCell className="w-32">
                        <SkeletonLine className="w-20" />
                    </TableCell>
                    <TableCell className="w-8" />
                </TableRow>
            ))}
        </TableBody>
    );
}
