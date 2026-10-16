import { describe, expect, it, vi } from "vitest";
import {
    deleteTabularReviewsWithConcurrency,
    notifyBulkReviewDeleteOutcome,
} from "./deleteTabularReviewsWithConcurrency";
import { notifyPartialFailure } from "@/app/lib/userFacingError";

vi.mock("@/app/lib/userFacingError", () => ({
    notifyPartialFailure: vi.fn(),
}));

describe("deleteTabularReviewsWithConcurrency", () => {
    it("limits concurrent requests and reports only confirmed deletions", async () => {
        let activeRequests = 0;
        let maxActiveRequests = 0;
        const deleteReview = vi.fn(async (reviewId: string) => {
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 1));
            activeRequests -= 1;
            if (reviewId === "review-3" || reviewId === "review-7")
                throw new Error("delete failed");
        });
        const reviewIds = Array.from(
            { length: 10 },
            (_, index) => `review-${index}`,
        );

        const result = await deleteTabularReviewsWithConcurrency(
            reviewIds,
            deleteReview,
            3,
        );

        expect(maxActiveRequests).toBeLessThanOrEqual(3);
        expect(deleteReview).toHaveBeenCalledTimes(10);
        expect(result.deletedIds).toEqual(
            reviewIds.filter((id) => id !== "review-3" && id !== "review-7"),
        );
        expect(result.failedIds).toEqual(["review-3", "review-7"]);
    });

    it("returns empty results for empty input without calling delete", async () => {
        const deleteReview = vi.fn();

        const result = await deleteTabularReviewsWithConcurrency(
            [],
            deleteReview,
        );

        expect(result).toEqual({ deletedIds: [], failedIds: [] });
        expect(deleteReview).not.toHaveBeenCalled();
    });

    it("clamps a non-positive concurrency to a single worker and still deletes", async () => {
        const order: string[] = [];
        const deleteReview = vi.fn(async (id: string) => {
            order.push(id);
        });

        const result = await deleteTabularReviewsWithConcurrency(
            ["review-1", "review-2"],
            deleteReview,
            0,
        );

        // Math.max(1, floor(0)) keeps one worker alive; a naive 0 would spawn
        // no workers and silently delete nothing.
        expect(order).toEqual(["review-1", "review-2"]);
        expect(result.deletedIds).toEqual(["review-1", "review-2"]);
    });

    it("deduplicates ids before deleting", async () => {
        const deleteReview = vi.fn().mockResolvedValue(undefined);

        const result = await deleteTabularReviewsWithConcurrency(
            ["review-1", "review-1", "review-2"],
            deleteReview,
        );

        expect(deleteReview).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            deletedIds: ["review-1", "review-2"],
            failedIds: [],
        });
    });
});

describe("notifyBulkReviewDeleteOutcome", () => {
    it("names skipped and failed rows in one notice, with Retry only for failures", () => {
        const retry = vi.fn();
        notifyBulkReviewDeleteOutcome({ blocked: 1, failedCount: 2, retry });

        expect(notifyPartialFailure).toHaveBeenCalledWith(
            "1 selected review was skipped because only a review owner can delete them. 2 reviews were not deleted because the request failed. They remain selected so you can try again.",
            { action: "delete those reviews", onRetry: retry },
        );

        vi.mocked(notifyPartialFailure).mockClear();
        notifyBulkReviewDeleteOutcome({ blocked: 2, failedCount: 0, retry });
        expect(notifyPartialFailure).toHaveBeenCalledWith(
            expect.stringContaining("2 selected reviews were skipped"),
            { action: "delete those reviews", onRetry: undefined },
        );

        vi.mocked(notifyPartialFailure).mockClear();
        notifyBulkReviewDeleteOutcome({ blocked: 0, failedCount: 0, retry });
        expect(notifyPartialFailure).not.toHaveBeenCalled();
    });
});
