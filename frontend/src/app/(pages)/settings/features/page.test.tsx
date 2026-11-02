import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    updateResponseDetailsVisible: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            quickActionsVisible: true,
        },
        updateQuickActionsVisible: vi.fn(),
        updateResponseDetailsVisible: state.updateResponseDetailsVisible,
    }),
}));

vi.mock("@/app/components/settings/WebSearchSection", () => ({
    WebSearchSection: () => null,
}));

describe("FeaturesPage CourtListener", () => {
    it("is managed from Connectors, not here", () => {
        render(<FeaturesPage />);
        expect(screen.queryByText(/CourtListener/)).not.toBeInTheDocument();
    });
});

describe("FeaturesPage response details", () => {
    it("starts off and saves the user's choice", async () => {
        state.updateResponseDetailsVisible.mockResolvedValue(true);
        const user = userEvent.setup();
        render(<FeaturesPage />);

        const toggle = screen.getByRole("switch", { name: "Response details" });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        await user.click(toggle);
        await waitFor(() =>
            expect(state.updateResponseDetailsVisible).toHaveBeenCalledWith(true),
        );
    });
});
