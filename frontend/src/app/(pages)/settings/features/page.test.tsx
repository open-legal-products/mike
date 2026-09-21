import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    source: "env" as "env" | "user" | null,
    usptoEnabled: false,
    degraded: false,
    reloadProfile: vi.fn(),
    updateUsptoConnectorEnabled: vi.fn<(enabled: boolean) => Promise<boolean>>(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            legalResearchUs: true,
            quickActionsVisible: true,
            usptoConnectorEnabled: state.usptoEnabled,
            apiKeys: {
                courtlistener: {
                    configured: state.source !== null,
                    source: state.source,
                },
            },
        },
        apiKeysDegraded: state.degraded,
        reloadProfile: state.reloadProfile,
        updateApiKey: vi.fn(),
        updateLegalResearchUs: vi.fn(),
        updateUsptoConnectorEnabled: state.updateUsptoConnectorEnabled,
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

describe("FeaturesPage USPTO connector", () => {
    beforeEach(() => {
        state.usptoEnabled = false;
        state.degraded = false;
        state.reloadProfile.mockReset();
        state.updateUsptoConnectorEnabled.mockReset();
        state.updateUsptoConnectorEnabled.mockResolvedValue(true);
    });

    it("renders the row with the switch off by default", () => {
        render(<FeaturesPage />);
        expect(
            screen.getByRole("switch", { name: "USPTO Patent & Trademark" }),
        ).toHaveAttribute("aria-checked", "false");
    });

    it("calls updateUsptoConnectorEnabled(true) when toggled on", () => {
        render(<FeaturesPage />);
        fireEvent.click(
            screen.getByRole("switch", { name: "USPTO Patent & Trademark" }),
        );
        expect(state.updateUsptoConnectorEnabled).toHaveBeenCalledWith(true);
    });

    it("shows a retry and disables the switch when the profile is degraded", () => {
        state.degraded = true;
        render(<FeaturesPage />);

        expect(screen.getByText(/Could not load settings/)).toBeTruthy();
        const retry = screen.getByRole("button", { name: "Retry" });
        fireEvent.click(retry);
        expect(state.reloadProfile).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("switch", { name: "USPTO Patent & Trademark" }),
        ).toBeDisabled();
    });

    it("shows Set up in Connectors only when enabled", () => {
        const { unmount } = render(<FeaturesPage />);
        expect(screen.queryByText("Set up in Connectors")).toBeNull();
        unmount();

        state.usptoEnabled = true;
        render(<FeaturesPage />);
        expect(screen.getByText("Set up in Connectors")).toHaveAttribute(
            "href",
            "/settings/connectors",
        );
    });
});
