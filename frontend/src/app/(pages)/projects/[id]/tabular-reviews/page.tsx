"use client";

import { use, useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    deleteTabularReview,
    listProjectReviewCreators,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import {
    distinctPeople,
    localPeople,
    type LoadPeople,
    type PersonOption,
} from "@/app/components/shared/PersonFilter";
import { ReviewsListTable } from "@/app/components/tabular/ReviewsListTable";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { TabularReview } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { can, roleFrom } from "@/app/lib/permissions";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import {
    type TabularReviewSortKey,
    type TabularReviewSortDirection,
    usePaginatedTabularReviews,
} from "@/app/hooks/usePaginatedTabularReviews";
import {
    deleteTabularReviewsWithConcurrency,
    notifyBulkReviewDeleteOutcome,
} from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectTabularReviewsPage({ params }: Props) {
    use(params);
    const workspace = useProjectWorkspace();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const { project, projectId, search, setOwnerOnlyAction } = workspace;
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [deletingReviewIds, setDeletingReviewIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [sort, setSort] = useState<{
        key: TabularReviewSortKey;
        direction: TabularReviewSortDirection;
    } | null>(null);
    const debouncedSearch = useDebouncedValue(search, 250);
    const [creator, setCreator] = useState<PersonOption | null>(null);
    const {
        reviews,
        setReviews,
        loading,
        loadingMore,
        hasMore,
        error: loadError,
        loadMoreError,
        loadMore,
        retry,
        selectedReviewIds,
        setSelectedReviewIds,
        selectAllMatching,
        selectingAll,
        getReviewOwnerId,
    } = usePaginatedTabularReviews({
        projectId,
        search: debouncedSearch,
        selectionKey: search,
        sort,
        ownerUserId: creator?.user_id,
    });
    // Every creator in the project, not just those on the loaded page.
    const loadCreators = useCallback<LoadPeople>(
        async (query, signal) =>
            localPeople(
                distinctPeople(
                    await listProjectReviewCreators(projectId, signal),
                ),
            )(query, signal),
        [projectId],
    );
    const docs = project?.documents ?? [];
    const visibleReviews = useMemo(
        () => (previewEmptyStates ? [] : reviews),
        [previewEmptyStates, reviews],
    );
    const effectiveLoading = loading && !previewEmptyStates;

    function handleOpenDetails(review: TabularReview) {
        // Each row carries its own merged access_role now. Details editing is
        // member-tier — the server's PATCH asks for content.edit — so the
        // list must refuse with the member sentence the review page uses.
        if (!can(roleFrom(review), "content.edit")) {
            setOwnerOnlyAction({
                action: "edit tabular review details",
                requiredRole: "editor",
            });
            return;
        }
        setDetailsReview(review);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview) return;
        if (!can(roleFrom(detailsReview), "content.edit")) {
            setOwnerOnlyAction({
                action: "edit tabular review details",
                requiredRole: "editor",
            });
            return;
        }
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: projectId,
        });
        setReviews((prev) =>
            prev.map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }

    function handleToggleAllReviews() {
        const allSelected =
            visibleReviews.length > 0 &&
            visibleReviews.every((review) =>
                selectedReviewIds.includes(review.id),
            );
        if (allSelected) setSelectedReviewIds([]);
        else void selectAllMatching();
    }

    async function handleDeleteReviewRow(review: TabularReview) {
        if (!can(roleFrom(review), "container.delete")) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        const snapshot = reviews;
        setDeletingReviewIds((current) => new Set(current).add(review.id));
        setReviews((current) =>
            current.filter((candidate) => candidate.id !== review.id),
        );
        try {
            await deleteTabularReview(review.id);
        } catch (error) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, [review.id]),
            );
            throw error;
        } finally {
            setDeletingReviewIds((current) => {
                const next = new Set(current);
                next.delete(review.id);
                return next;
            });
        }
    }

    const retryDeleteSelectedRef = useRef<((ids: string[]) => void) | null>(
        null,
    );
    // `ids` is passed only by Retry, so it re-sends exactly the batch that
    // failed, whatever is selected by then.
    const handleDeleteSelectedReviews = useCallback(async (
        ids: string[] = [...selectedReviewIds],
    ) => {
        const roleById = new Map(
            reviews.map((review) => [review.id, roleFrom(review)] as const),
        );
        const owned = ids.filter((id) => {
            const role = roleById.get(id);
            if (role) return can(role, "container.delete");
            const ownerId = getReviewOwnerId(id);
            return !!ownerId && ownerId === user?.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedReviewIds([]);
        const snapshot = reviews;
        setReviews((current) =>
            current.filter((review) => !owned.includes(review.id)),
        );
        const { failedIds } =
            await deleteTabularReviewsWithConcurrency(
                owned,
                deleteTabularReview,
            );
        setSelectedReviewIds(failedIds);
        if (failedIds.length > 0) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
            );
        }
        notifyBulkReviewDeleteOutcome({
            blocked,
            failedCount: failedIds.length,
            // Through the ref for the newest handler, with only the ids
            // that failed.
            retry: () => retryDeleteSelectedRef.current?.(failedIds),
        });
    }, [
        getReviewOwnerId,
        reviews,
        selectedReviewIds,
        setReviews,
        setSelectedReviewIds,
        user?.id,
    ]);

    // "Retry" must re-enter the newest handler, not the one that was
    // created when the delete failed.
    useAssignLatest(retryDeleteSelectedRef, (ids: string[]) => void handleDeleteSelectedReviews(ids));

    return (
        <>
            <ReviewsListTable
                renderToolbar={(actions) => <ProjectSectionToolbar actions={actions} />}
                rowClassName="pr-8 md:pr-8"
                showCreator
                creatorFilter={{
                    value: creator,
                    onChange: setCreator,
                    loadPeople: loadCreators,
                }}
                reviews={visibleReviews}
                selectedReviewIds={selectedReviewIds}
                createDisabled={workspace.creatingReview || docs.length === 0}
                emptyDescription="Extract data from project documents into tables using AI."
                loading={effectiveLoading}
                loadingMore={loadingMore}
                hasMore={hasMore}
                error={loadError}
                loadMoreError={loadMoreError}
                onToggleAll={handleToggleAllReviews}
                selectingAll={selectingAll}
                deletingReviewIds={deletingReviewIds}
                hasActiveFilters={
                    debouncedSearch.trim().length > 0 || creator !== null
                }
                sort={sort}
                onSortChange={(key, direction) => {
                    setSelectedReviewIds([]);
                    setSort(direction ? { key, direction } : null);
                }}
                onLoadMore={() => void loadMore()}
                onRetry={retry}
                onCreateReview={workspace.openNewReview}
                onOpenReview={(review) =>
                    router.push(
                        `/projects/${projectId}/tabular-reviews/${review.id}`,
                    )
                }
                onOpenDetails={handleOpenDetails}
                onDeleteReview={handleDeleteReviewRow}
                onDeleteSelectedReviews={() => handleDeleteSelectedReviews()}
                onOwnerOnlyAction={setOwnerOnlyAction}
                setSelectedReviewIds={setSelectedReviewIds}
            />
            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={project ? [project] : []}
                canEdit={
                    !!detailsReview &&
                    can(roleFrom(detailsReview), "content.edit")
                }
                lockProject
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />
        </>
    );
}
