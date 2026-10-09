import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { getTabularReview, listProjects } from "@/app/lib/mikeApi";
import { TRView } from "./TabularReviewView";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularReview: vi.fn(),
    listProjects: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { apiKeys: {} },
        loading: false,
        apiKeysDegraded: false,
    }),
}));
vi.mock("./TRTable", () => ({ TRTable: () => <div /> }));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => <div /> }));
vi.mock("./TRSidePanel", () => ({ TRSidePanel: () => <div /> }));

const emptyDetail = {
    review: {
        id: "review-1",
        title: "Diligence",
        columns_config: [],
        is_running: false,
        updated_at: "2026-01-01T00:00:00.000Z",
    },
    cells: [],
    rows: [],
    documents: [],
} as unknown as Awaited<ReturnType<typeof getTabularReview>>;

describe("TRView failure reporting", () => {
    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        );
        vi.stubGlobal(
            "matchMedia",
            (query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                addListener: vi.fn(),
                removeListener: vi.fn(),
                dispatchEvent: vi.fn(),
            }),
        );
        vi.mocked(getTabularReview).mockResolvedValue(emptyDetail);
        vi.mocked(listProjects).mockResolvedValue([]);
    });
    afterEach(() => {
        clearToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("reports a review that could not be loaded instead of showing an empty one", async () => {
        vi.mocked(getTabularReview).mockRejectedValue(new Error("boom"));

        render(
            <>
                <TRView reviewId="review-1" />
                <ToastViewportUI />
            </>,
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load this review");
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
    });

    it("reports a project list that could not be loaded", async () => {
        vi.mocked(listProjects).mockRejectedValue(new Error("boom"));

        render(
            <>
                <TRView reviewId="review-1" />
                <ToastViewportUI />
            </>,
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load your projects");
    });
});
