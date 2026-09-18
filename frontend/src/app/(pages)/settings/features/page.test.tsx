import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    source: "env" as "env" | "user" | null,
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
        updateLegalResearchUs: vi.fn(),
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
