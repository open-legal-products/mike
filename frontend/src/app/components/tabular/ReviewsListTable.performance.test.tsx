import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewsListTable } from "./ReviewsListTable";
import type { TabularReview } from "@/app/components/shared/types";
import { countIndexReads } from "@/app/__tests__/countIndexReads";

describe("ReviewsListTable selection rendering", () => {
    it.each([100, 200])("reads a %i-review selection once per render, not once per row", (n) => {
        const reviews = Array.from({ length: n }, (_, i) => ({
            id: `r${i}`,
            title: `Review ${i}`,
            user_id: "me",
            created_at: new Date(0).toISOString(),
            access_role: "owner",
            is_owner: true,
        })) as unknown as TabularReview[];
        const { proxy, reads } = countIndexReads(reviews.map((review) => review.id));
        render(
            <ReviewsListTable
                reviews={reviews}
                selectedReviewIds={proxy}
                createDisabled={false}
                emptyDescription=""
                onCreateReview={vi.fn()}
                onDeleteSelectedReviews={vi.fn()}
                onOpenReview={vi.fn()}
                onOpenDetails={vi.fn()}
                onDeleteReview={vi.fn()}
                onOwnerOnlyAction={vi.fn()}
                setSelectedReviewIds={vi.fn()}
                onToggleAll={vi.fn()}
                deletingReviewIds={new Set<string>()}
                hasActiveFilters={false}
                sort={null}
                onSortChange={vi.fn()}
                hasMore={false}
                loadingMore={false}
                error={null}
                loadMoreError={null}
                onLoadMore={vi.fn()}
                onRetry={vi.fn()}
            />,
        );
        expect(screen.getByText(`Review ${n - 1}`)).toBeInTheDocument();
        expect(reads.count).toBeLessThanOrEqual(2 * n);
    });
});
