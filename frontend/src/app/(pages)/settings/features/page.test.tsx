import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    source: "env" as "env" | "user" | null,
    updateLegalResearchUs: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            legalResearchUs: true,
            quickActionsVisible: true,
            apiKeys: {
                courtlistener: {
                    configured: state.source !== null,
                    source: state.source,
                },
            },
        },
        updateApiKey: vi.fn(),
        updateLegalResearchUs: state.updateLegalResearchUs,
        updateQuickActionsVisible: vi.fn(),
    }),
}));

vi.mock("@/app/components/settings/ApiKeyField", () => ({
    ApiKeyField: ({ hasSavedKey }: { hasSavedKey: boolean }) => (
        <div data-testid="courtlistener-key-state">
            {hasSavedKey ? "personal" : "server-or-empty"}
        </div>
    ),
}));

describe("FeaturesPage CourtListener key", () => {
    beforeEach(() => {
        state.source = "env";
    });

    it("does not offer removal for a server-configured token", () => {
        render(<FeaturesPage />);
        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent(
            "server-or-empty",
        );
    });

    it("marks a personal token as saved", () => {
        state.source = "user";
        render(<FeaturesPage />);
        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent(
            "personal",
        );
    });
});

describe("FeaturesPage save failures", () => {
    it("reports a failed toggle only through the notice", async () => {
        // The profile context raises the notice (with Retry) itself; the row
        // must not repeat the failure inline.
        state.source = "env";
        state.updateLegalResearchUs.mockResolvedValue(false);
        const user = userEvent.setup();
        render(<FeaturesPage />);

        await user.click(
            screen.getByRole("switch", { name: "Enable CourtListener" }),
        );
        await waitFor(() =>
            expect(state.updateLegalResearchUs).toHaveBeenCalledWith(false),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
});
