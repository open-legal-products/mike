import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    CourtListenerConnector,
    courtListenerTokenStatus,
} from "./CourtListenerConnector";

const state = vi.hoisted(() => ({
    hasProfile: true,
    legalResearchUs: true,
    source: "env" as "env" | "org" | "user" | null,
    updateApiKey: vi.fn(),
    updateLegalResearchUs: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: state.hasProfile
            ? {
                  legalResearchUs: state.legalResearchUs,
                  apiKeys: {
                      courtlistener: {
                          configured: state.source !== null,
                          source: state.source,
                      },
                  },
              }
            : null,
        updateApiKey: state.updateApiKey,
        updateLegalResearchUs: state.updateLegalResearchUs,
    }),
}));

// The key field has its own tests; here it shows whether a personal token
// counts as saved, and hands its actions to the dialog.
vi.mock("./ApiKeyField", () => ({
    ApiKeyField: ({
        hasSavedKey,
        onRemove,
        render,
    }: {
        hasSavedKey: boolean;
        onRemove: () => Promise<boolean>;
        render: (
            fields: ReactNode,
            saveAction: { label: string; onClick: () => Promise<void>; disabled: boolean },
            removeAction:
                | { label: string; onClick: () => Promise<void>; disabled: boolean }
                | undefined,
        ) => ReactNode;
    }) =>
        render(
            <div data-testid="courtlistener-key-state">
                {hasSavedKey ? "personal" : "server-or-empty"}
            </div>,
            { label: "Save", onClick: async () => {}, disabled: true },
            hasSavedKey
                ? {
                      label: "Remove",
                      onClick: async () => {
                          await onRemove();
                      },
                      disabled: false,
                  }
                : undefined,
        ),
}));

describe("courtListenerTokenStatus", () => {
    it("names where the token comes from", () => {
        expect(courtListenerTokenStatus("user")).toBe("Uses your API token");
        expect(courtListenerTokenStatus("org")).toBe(
            "Uses your organization's API token",
        );
        expect(courtListenerTokenStatus("env")).toBe(
            "Uses this deployment's API token",
        );
        expect(courtListenerTokenStatus(null)).toBe("Needs an API token");
    });
});

describe("CourtListenerConnector", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.hasProfile = true;
        state.legalResearchUs = true;
        state.source = "env";
        state.updateApiKey.mockResolvedValue(true);
        state.updateLegalResearchUs.mockResolvedValue(true);
    });

    it("shows the research setting as the connector switch", () => {
        state.legalResearchUs = false;
        render(<CourtListenerConnector />);
        const toggle = screen.getByRole("switch", {
            name: "CourtListener connector",
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(screen.getByText("Uses this deployment's API token")).toBeTruthy();
    });

    it("asks for a token when none is configured", () => {
        state.source = null;
        render(<CourtListenerConnector />);
        expect(screen.getByText("Needs an API token")).toBeTruthy();
    });

    it("holds the switch until the profile has loaded", () => {
        state.hasProfile = false;
        render(<CourtListenerConnector />);
        expect(
            screen.getByRole("switch", { name: "CourtListener connector" }),
        ).toBeDisabled();
    });

    it("saves the switch and reports a failure only through the notice", async () => {
        // The profile context raises the notice (with Retry) itself; the card
        // must not repeat the failure inline.
        state.updateLegalResearchUs.mockResolvedValue(false);
        const user = userEvent.setup();
        render(<CourtListenerConnector />);

        await user.click(
            screen.getByRole("switch", { name: "CourtListener connector" }),
        );
        await waitFor(() =>
            expect(state.updateLegalResearchUs).toHaveBeenCalledWith(false),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("does not offer removal for a deployment's token", async () => {
        const user = userEvent.setup();
        render(<CourtListenerConnector />);

        await user.click(screen.getByRole("button", { name: "Manage CourtListener" }));

        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveTextContent("Uses this deployment's API token");
        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent(
            "server-or-empty",
        );
        expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    });

    it("lets a personal token be cleared from Manage", async () => {
        state.source = "user";
        const user = userEvent.setup();
        render(<CourtListenerConnector />);

        await user.click(screen.getByRole("button", { name: "Manage CourtListener" }));
        expect(
            await screen.findByTestId("courtlistener-key-state"),
        ).toHaveTextContent("personal");
        expect(
            screen.getByRole("switch", { name: "Enable CourtListener" }),
        ).toHaveAttribute("aria-checked", "true");

        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(state.updateApiKey).toHaveBeenCalledWith("courtlistener", null);
    });
});
