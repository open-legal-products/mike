"use client";

import { use, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { deleteTabularReview, updateTabularReview } from "@/app/lib/mikeApi";
import { ProjectReviewsTable } from "@/app/components/projects/ProjectReviewsTable";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { TabularReview } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import {
    type TabularReviewSortKey,
    type TabularReviewSortDirection,
    usePaginatedTabularReviews,
} from "@/app/hooks/usePaginatedTabularReviews";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";

interface Props {
    params: Promise<{ id: string }>;
}

function SelectedReviewActions({
    selectedCount,
    open,
    onOpenChange,
    onDelete,
}: {
    selectedCount: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDelete: () => void;
}) {
    if (selectedCount === 0) return null;

    return (
        <div className="relative">
            <TabPillButton onClick={() => onOpenChange(!open)}>
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
            </TabPillButton>
            {open && (
                <div className="absolute right-0 top-full z-[120] mt-1 w-36 overflow-hidden rounded-lg border border-white/60 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_32px_rgba(15,23,42,0.14)] backdrop-blur-xl">
                    <button
                        onClick={onDelete}
                        className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50"
                    >
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
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
    const [actionsOpen, setActionsOpen] = useState(false);
    const [bulkDeleteNotice, setBulkDeleteNotice] = useState<string | null>(
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
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        setDetailsReview(review);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview) return;
        if (user?.id && detailsReview.user_id !== user.id) {
            setOwnerOnlyAction("edit tabular review details");
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
        if (user?.id && review.user_id !== user.id) {
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

    const handleDeleteSelectedReviews = useCallback(async () => {
        const ids = [...selectedReviewIds];
        setActionsOpen(false);
        setBulkDeleteNotice(null);
        const owned = ids.filter((id) => {
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
                ? `${blocked} selected review${blocked === 1 ? " was" : "s were"} skipped because only the review creator can delete them.`
                : null,
            failedIds.length > 0
                ? `${failedIds.length} review${failedIds.length === 1 ? " was" : "s were"} not deleted because the request failed. ${failedIds.length === 1 ? "It remains" : "They remain"} selected so you can try again.`
                : null,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0) setBulkDeleteNotice(notices.join(" "));
    }, [
        getReviewOwnerId,
        reviews,
        selectedReviewIds,
        setReviews,
        setSelectedReviewIds,
        user?.id,
    ]);

    return (
        <>
            <ProjectSectionToolbar
                actions={
                    selectedReviewIds.length > 0 ? (
                        <SelectedReviewActions
                            selectedCount={selectedReviewIds.length}
                            open={actionsOpen}
                            onOpenChange={setActionsOpen}
                            onDelete={() => void handleDeleteSelectedReviews()}
                        />
                    ) : undefined
                }
            />
            <ProjectReviewsTable
                docs={docs}
                reviews={visibleReviews}
                selectedReviewIds={selectedReviewIds}
                creatingReview={workspace.creatingReview}
                currentUserId={user?.id}
                loading={effectiveLoading}
                loadingMore={loadingMore}
                hasMore={hasMore}
                error={loadError}
                loadMoreError={loadMoreError}
                onToggleAll={handleToggleAllReviews}
                selectingAll={selectingAll}
                deletingReviewIds={deletingReviewIds}
                hasActiveSearch={debouncedSearch.trim().length > 0}
                sort={sort}
                onSortChange={(key, direction) => {
                    setSelectedReviewIds([]);
                    setSort(direction ? { key, direction } : null);
                }}
                onLoadMore={() => void loadMore()}
                onRetry={retry}
                onCreateReview={workspace.openNewReview}
                onOpenReview={(reviewId) =>
                    router.push(
                        `/projects/${projectId}/tabular-reviews/${reviewId}`,
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
                    (!user?.id || detailsReview.user_id === user.id)
                }
                lockProject
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />
            <WarningPopup
                open={!!bulkDeleteNotice}
                title="Some reviews were not deleted"
                message={bulkDeleteNotice}
                onClose={() => setBulkDeleteNotice(null)}
            />
        </>
    );
}
