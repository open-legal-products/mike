import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { ProjectReviewsTable } from "./ProjectReviewsTable";
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
}) {
    return render(
        withIntl(
            <ProjectReviewsTable
                docs={[]}
                reviews={[row]}
                selectedReviewIds={[]}
                creatingReview={false}
                onCreateReview={vi.fn()}
                onDeleteSelectedReviews={vi.fn()}
                onOpenReview={vi.fn()}
                onOpenDetails={handlers.onOpenDetails}
                onDeleteReview={vi.fn()}
                onOwnerOnlyAction={handlers.onOwnerOnlyAction}
                setSelectedReviewIds={vi.fn()}
                onToggleAll={vi.fn()}
                deletingReviewIds={new Set<string>()}
                hasActiveSearch={false}
                sort={{ key: "created", direction: "desc" }}
                onSortChange={vi.fn()}
                hasMore={false}
                loadingMore={false}
                error={null}
                loadMoreError={null}
                onLoadMore={vi.fn()}
                onRetry={vi.fn()}
            />,
            // The popup namespace lands with this translation batch; the
            // shared catalog still does not carry it.
            {
                popups: {
                    permissao: {
                        acaoEditarDetalhesRevisao:
                            "editar os detalhes desta revisão tabular",
                    },
                },
            },
        ),
    );
}

async function clickEditDetails() {
    const menuButton = screen.getAllByRole("button", {
        name: "Abrir ações da linha",
    })[0];
    fireEvent.click(menuButton);
    const edit = await screen.findByText("Editar detalhes");
    fireEvent.click(edit);
}

describe("ProjectReviewsTable details gate", () => {
    it("lets an editor open details — the tier the server's PATCH enforces", async () => {
        const onOpenDetails = vi.fn();
        const onOwnerOnlyAction = vi.fn();
        renderTable(review("editor"), { onOpenDetails, onOwnerOnlyAction });

        await clickEditDetails();

        expect(onOpenDetails).toHaveBeenCalledTimes(1);
        expect(onOwnerOnlyAction).not.toHaveBeenCalled();
    });

    it("refuses a viewer with the editor tier, not the owner one", async () => {
        const onOpenDetails = vi.fn();
        const onOwnerOnlyAction = vi.fn();
        renderTable(review("viewer"), { onOpenDetails, onOwnerOnlyAction });

        await clickEditDetails();

        expect(onOpenDetails).not.toHaveBeenCalled();
        expect(onOwnerOnlyAction).toHaveBeenCalledWith({
            action: "editar os detalhes desta revisão tabular",
            requiredRole: "editor",
        });
    });
});
