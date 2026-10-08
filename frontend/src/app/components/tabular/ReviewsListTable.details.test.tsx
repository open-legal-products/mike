import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewsListTable } from "./ReviewsListTable";
import type { TabularReview } from "@/app/components/shared/types";

// The live round caught the list surfaces refusing "edit details" at the
// admin tier while the review page (correctly) allows a member — same user,
// same review, opposite answers. These tests pin the list to the server's
// actual rule: the details PATCH asks for content.edit, which member holds.

function review(access_role: string): TabularReview {
    return {
        id: "r1",
        title: "Gating TR",
        user_id: "someone-else",
        created_at: new Date().toISOString(),
        access_role,
        is_owner: false,
    } as unknown as TabularReview;
}

function renderTable(row: TabularReview, handlers: {
    onOpenDetails: (r: TabularReview) => void;
    onOwnerOnlyAction: (gate: unknown) => void;
}, overrides: Partial<ComponentProps<typeof ReviewsListTable>> = {}) {
    return render(
        <ReviewsListTable
            renderToolbar={(actions) => <>{actions}</>}
            reviews={[row]}
            selectedReviewIds={[]}
            createDisabled={false}
            emptyDescription="Extract data from documents into tables using AI."
            onCreateReview={vi.fn()}
            onDeleteSelectedReviews={vi.fn()}
            onOpenReview={vi.fn()}
            onOpenDetails={handlers.onOpenDetails}
            onDeleteReview={vi.fn()}
            onOwnerOnlyAction={handlers.onOwnerOnlyAction}
            setSelectedReviewIds={vi.fn()}
            onToggleAll={vi.fn()}
            deletingReviewIds={new Set<string>()}
            hasActiveFilters={false}
            sort={{ key: "created", direction: "desc" }}
            onSortChange={vi.fn()}
            hasMore={false}
            loadingMore={false}
            error={null}
            loadMoreError={null}
            onLoadMore={vi.fn()}
            onRetry={vi.fn()}
            {...overrides}
        />,
    );
}

async function clickEditDetails(surface: "row" | "toolbar") {
    const menuButton = screen.getAllByRole("button", {
        name: surface === "row" ? /row actions/i : "Actions",
    })[0];
    // Radix opens on pointerdown, not click.
    fireEvent.pointerDown(
        menuButton,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    const edit = await screen.findByText(/edit details/i);
    fireEvent.click(edit);
}

describe("ReviewsListTable details gate", () => {
    it.each([1, 2])("matches toolbar and right-click actions for %i selected reviews", async (count) => {
        const user = userEvent.setup();
        const rows = [review("owner"), { ...review("owner"), id: "r2", title: "Other review" }];
        const onDeleteReview = vi.fn();
        const onDeleteSelectedReviews = vi.fn();
        renderTable(rows[0], { onOpenDetails: vi.fn(), onOwnerOnlyAction: vi.fn() }, {
            reviews: rows,
            selectedReviewIds: rows.slice(0, count).map((row) => row.id),
            onDeleteReview,
            onDeleteSelectedReviews,
        });
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const toolbarItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
        expect(toolbarItems).toEqual(count === 1 ? ["Open", "Edit details", "Delete"] : ["Delete 2 reviews"]);
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("Gating TR"));
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(toolbarItems);
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: count === 1 ? "Delete" : "Delete 2 reviews" }));
        expect(count === 1 ? onDeleteReview : onDeleteSelectedReviews).toHaveBeenCalledOnce();
        expect(count === 1 ? onDeleteSelectedReviews : onDeleteReview).not.toHaveBeenCalled();
    });

    it.each(["row", "toolbar"] as const)("lets an editor open details from the %s menu", async (surface) => {
        const onOpenDetails = vi.fn();
        const onOwnerOnlyAction = vi.fn();
        renderTable(review("editor"), { onOpenDetails, onOwnerOnlyAction }, { selectedReviewIds: ["r1"] });

        await clickEditDetails(surface);

        expect(onOpenDetails).toHaveBeenCalledTimes(1);
        expect(onOwnerOnlyAction).not.toHaveBeenCalled();
    });

    it.each(["row", "toolbar"] as const)("refuses a viewer from the %s menu with the editor tier", async (surface) => {
        const onOpenDetails = vi.fn();
        const onOwnerOnlyAction = vi.fn();
        renderTable(review("viewer"), { onOpenDetails, onOwnerOnlyAction }, { selectedReviewIds: ["r1"] });

        await clickEditDetails(surface);

        expect(onOpenDetails).not.toHaveBeenCalled();
        expect(onOwnerOnlyAction).toHaveBeenCalledWith(
            { action: "edit tabular review details", requiredRole: "editor" },
            expect.objectContaining({ id: "r1" }),
        );
    });
});
