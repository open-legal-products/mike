import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TabularReview } from "@/app/components/shared/types";
import TabularReviewsPage from "./page";

const { data, push, deleteReview } = vi.hoisted(() => ({
    data: { reviews: [] as TabularReview[], selectedIds: [] as string[] },
    push: vi.fn(),
    deleteReview: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/tabular-reviews",
    useRouter: () => ({ push, replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "owner" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listProjects: vi.fn(async () => []),
    deleteTabularReview: deleteReview,
}));
vi.mock("@/app/hooks/usePaginatedTabularReviews", () => ({
    usePaginatedTabularReviews: () => ({
        reviews: data.reviews,
        selectedReviewIds: data.selectedIds,
        setSelectedReviewIds: vi.fn(),
        setReviews: vi.fn(),
        loading: false,
        loadingMore: false,
        hasMore: false,
        error: null,
        loadMoreError: null,
        loadMore: vi.fn(),
        retry: vi.fn(),
        selectAllMatching: vi.fn(),
        selectingAll: false,
        getReviewOwnerId: () => "owner",
    }),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("@/app/components/tabular/NewTRModal", () => ({ NewTRModal: () => null }));
vi.mock("@/app/components/tabular/TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: ({ open, review }: { open: boolean; review: TabularReview | null }) =>
        open ? <div role="dialog" aria-label="Review details">{review?.title}</div> : null,
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })));
    deleteReview.mockResolvedValue(undefined);
    data.reviews = ["r1", "r2"].map((id) => ({
        id,
        title: `Review ${id}`,
        project_id: "p1",
        user_id: "owner",
        access_role: "owner",
        status: "ready",
        columns_config: [],
        document_count: 0,
        created_at: "2026-10-01T00:00:00Z",
    } as unknown as TabularReview));
    data.selectedIds = ["r1"];
});

afterEach(() => vi.unstubAllGlobals());

describe("review overview selection actions", () => {
    it.each([1, 2])("matches toolbar and right-click menus for %i selected reviews", async (count) => {
        const user = userEvent.setup();
        data.selectedIds = data.reviews.slice(0, count).map((review) => review.id);
        render(<TabularReviewsPage />);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
        expect(items).toEqual(count === 1 ? ["Open", "Edit details", "Delete"] : ["Delete 2 reviews"]);
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("Review r1"));
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
    });

    it("opens a selected project review from the toolbar", async () => {
        const user = userEvent.setup();
        render(<TabularReviewsPage />);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Open" }));
        expect(push).toHaveBeenCalledWith("/projects/p1/tabular-reviews/r1");
    });

    it("opens details for a single selected review", async () => {
        const user = userEvent.setup();
        render(<TabularReviewsPage />);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Edit details" }));
        expect(screen.getByRole("dialog", { name: "Review details" })).toHaveTextContent("Review r1");
    });

    it("deletes all selected reviews, including a selection beyond the loaded page", async () => {
        const user = userEvent.setup();
        data.selectedIds = ["not-loaded", "r1", "r2"];
        render(<TabularReviewsPage />);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete 3 reviews" }));
        await waitFor(() => expect(deleteReview).toHaveBeenCalledTimes(3));
        for (const id of data.selectedIds) expect(deleteReview).toHaveBeenCalledWith(id);
    });
});
