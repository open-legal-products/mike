import { notifyPartialFailure } from "@/app/lib/userFacingError";

const DEFAULT_DELETE_CONCURRENCY = 5;

export interface BulkDeleteResult {
    deletedIds: string[];
    failedIds: string[];
}

export async function deleteTabularReviewsWithConcurrency(
    reviewIds: string[],
    deleteReview: (reviewId: string) => Promise<void>,
    concurrency = DEFAULT_DELETE_CONCURRENCY,
): Promise<BulkDeleteResult> {
    const uniqueIds = [...new Set(reviewIds)];
    if (uniqueIds.length === 0) return { deletedIds: [], failedIds: [] };

    const outcomes = new Map<string, "deleted" | "failed">();
    const workerCount = Math.min(
        uniqueIds.length,
        Math.max(1, Math.floor(concurrency)),
    );
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < uniqueIds.length) {
            const reviewId = uniqueIds[nextIndex++];
            try {
                await deleteReview(reviewId);
                outcomes.set(reviewId, "deleted");
            } catch {
                outcomes.set(reviewId, "failed");
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
        deletedIds: uniqueIds.filter((id) => outcomes.get(id) === "deleted"),
        failedIds: uniqueIds.filter((id) => outcomes.get(id) === "failed"),
    };
}

/**
 * Report a bulk review delete that skipped or failed some rows: one notice
 * for the batch, shared by the workspace and project review lists. Retry
 * (only when a request failed) re-runs the delete on the rows that are still
 * selected, which are exactly the ones that failed.
 */
export function notifyBulkReviewDeleteOutcome({
    blocked,
    failedCount,
    retry,
}: {
    blocked: number;
    failedCount: number;
    retry: () => void;
}): void {
    const notices = [
        blocked > 0
            ? `${blocked} selected review${blocked === 1 ? " was" : "s were"} skipped because only a review owner can delete them.`
            : null,
        failedCount > 0
            ? `${failedCount} review${failedCount === 1 ? " was" : "s were"} not deleted because the request failed. ${failedCount === 1 ? "It remains" : "They remain"} selected so you can try again.`
            : null,
    ].filter((notice): notice is string => notice !== null);
    if (notices.length === 0) return;
    notifyPartialFailure(notices.join(" "), {
        action: "delete those reviews",
        onRetry: failedCount > 0 ? retry : undefined,
    });
}
