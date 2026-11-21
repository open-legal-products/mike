import { notifyPartialFailure } from "@/app/lib/userFacingError";
import {
    BULK_REQUEST_CONCURRENCY,
    settleBulkRequests,
} from "@/app/lib/bulkRequests";

export interface BulkDeleteResult {
    deletedIds: string[];
    failedIds: string[];
}

export async function deleteTabularReviewsWithConcurrency(
    reviewIds: string[],
    deleteReview: (reviewId: string) => Promise<void>,
    concurrency = BULK_REQUEST_CONCURRENCY,
): Promise<BulkDeleteResult> {
    const { succeeded, failed } = await settleBulkRequests(
        [...new Set(reviewIds)],
        deleteReview,
        { concurrency },
    );
    return { deletedIds: succeeded, failedIds: failed };
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
