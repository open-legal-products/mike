"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { deleteTabularReview, updateTabularReview } from "@/app/lib/mikeApi";
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
import {
    type TabularReviewSortKey,
    type TabularReviewSortDirection,
    usePaginatedTabularReviews,
} from "@/app/hooks/usePaginatedTabularReviews";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import {
    UserVisibleError,
    notifyError,
} from "@/app/lib/userFacingError";

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
    });
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

    const retryDeleteSelectedRef = useRef(() => {});

    const handleDeleteSelectedReviews = useCallback(async () => {
        const ids = [...selectedReviewIds];
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
        const notices = [
            blocked > 0
                ? `${blocked} selected review${blocked === 1 ? " was" : "s were"} skipped because only a review owner can delete them.`
                : null,
            failedIds.length > 0
                ? `${failedIds.length} review${failedIds.length === 1 ? " was" : "s were"} not deleted because the request failed. ${failedIds.length === 1 ? "It remains" : "They remain"} selected so you can try again.`
                : null,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0) {
            // A partial failure is still a failure: it belongs in the same
            // toast stack as every other one, with a retry for the rows that
            // are still selected, rather than in a popup of its own.
            notifyError(
                // "conflict", not "unknown": the skipped rows are a 403 the
                // user already understands, so this must not be reported to
                // Sentry or offer "Contact support" (both follow "unknown").
                new UserVisibleError(notices.join(" "), {
                    kind: "conflict",
                    retryable: failedIds.length > 0,
                }),
                {
                    action: "delete those reviews",
                    // Through the ref, so the retry deletes the rows that are
                    // selected NOW (the ones that failed) rather than the
                    // whole original selection this closure captured.
                    onRetry:
                        failedIds.length > 0
                            ? () => retryDeleteSelectedRef.current()
                            : undefined,
                },
            );
        }
    }, [
        getReviewOwnerId,
        reviews,
        selectedReviewIds,
        setReviews,
        setSelectedReviewIds,
        user?.id,
    ]);

    // A toast's "Retry" must re-enter the newest handler, not the one that
    // was created when the delete failed.
    useEffect(() => {
        retryDeleteSelectedRef.current = () =>
            void handleDeleteSelectedReviews();
    }, [handleDeleteSelectedReviews]);

    return (
        <>
            <ReviewsListTable
                renderToolbar={(actions) => <ProjectSectionToolbar actions={actions} />}
                rowClassName="pr-8 md:pr-8"
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
                hasActiveFilters={debouncedSearch.trim().length > 0}
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
                onDeleteSelectedReviews={handleDeleteSelectedReviews}
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
