import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgPreferences } from "@/app/lib/mikeApi";
import FeaturesPage from "./page";

// In an organization's workspace the page edits the organization's settings,
// for its owners and admins; a member is told who sets them.

const state = vi.hoisted(() => ({
    scope: { kind: "organization", orgId: "org-1", orgName: "Acme LLP" } as
        | { kind: "organization"; orgId: string; orgName: string }
        | { kind: "managed"; orgName: string },
    initial: null as unknown as OrgPreferences,
    save: vi.fn(),
    notifyError: vi.fn(),
    updateQuickActionsVisible: vi.fn(),
}));

vi.mock("@/app/hooks/useWorkspaceSettingsScope", () => ({
    useWorkspaceSettingsScope: () => state.scope,
}));

// The organization's settings as the page sees them: a save that succeeds
// puts the server's answer in place, as WorkspaceContext does.
vi.mock("@/app/hooks/useOrgPreferencesSettings", async () => {
    const { useState } = await import("react");
    return {
        useOrgPreferencesSettings: () => {
            const [preferences, setPreferences] = useState(state.initial);
            return {
                preferences,
                loadError: false,
                retry: vi.fn(),
                save: async (update: Partial<OrgPreferences>) => {
                    const saved = await state.save(update);
                    setPreferences(saved);
                    return saved;
                },
            };
        },
    };
});

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { quickActionsVisible: true, responseDetailsVisible: false },
        updateQuickActionsVisible: state.updateQuickActionsVisible,
        updateResponseDetailsVisible: vi.fn(),
    }),
}));

vi.mock("@/app/components/settings/WebSearchSection", () => ({
    WebSearchSection: () => <p>Your web search</p>,
    OrganizationWebSearchSection: ({ orgId }: { orgId: string }) => (
        <p>Web search for {orgId}</p>
    ),
}));

vi.mock("@/app/lib/userFacingError", () => ({
    notifyError: state.notifyError,
}));

beforeEach(() => {
    vi.clearAllMocks();
    state.scope = { kind: "organization", orgId: "org-1", orgName: "Acme LLP" };
    state.initial = {
        title_model: null,
        tabular_model: null,
        memory_curator_model: null,
        subagent_model: null,
        subagent_reasoning: null,
        quick_actions_visible: false,
        response_details_visible: true,
        web_search: { enabled: false, claude: "provider", openai: "provider", other: "off" },
    };
    state.save.mockImplementation(async (update: Partial<OrgPreferences>) => ({
        ...state.initial,
        ...update,
    }));
});

describe("FeaturesPage in an organization's workspace", () => {
    it("shows the organization's settings, not the caller's", () => {
        render(<FeaturesPage />);
        expect(
            screen.getByRole("switch", { name: "Quick actions" }),
        ).toHaveAttribute("aria-checked", "false");
        expect(
            screen.getByRole("switch", { name: "Response details" }),
        ).toHaveAttribute("aria-checked", "true");
        expect(screen.getByText("Web search for org-1")).toBeInTheDocument();
        expect(screen.queryByText("Your web search")).toBeNull();
    });

    it("saves a change to the organization, not to the caller's profile", async () => {
        const user = userEvent.setup();
        render(<FeaturesPage />);

        await user.click(screen.getByRole("switch", { name: "Quick actions" }));

        expect(state.save).toHaveBeenCalledWith({ quick_actions_visible: true });
        expect(state.updateQuickActionsVisible).not.toHaveBeenCalled();
        await waitFor(() =>
            expect(
                screen.getByRole("switch", { name: "Quick actions" }),
            ).toHaveAttribute("aria-checked", "true"),
        );
    });

    it("reports a refused change and leaves the switch where it was", async () => {
        const refusal = new Error("refused");
        state.save.mockRejectedValueOnce(refusal);
        const user = userEvent.setup();
        render(<FeaturesPage />);

        await user.click(screen.getByRole("switch", { name: "Quick actions" }));

        await waitFor(() =>
            expect(state.notifyError).toHaveBeenCalledWith(
                refusal,
                expect.objectContaining({ action: "show quick actions" }),
            ),
        );
        expect(
            screen.getByRole("switch", { name: "Quick actions" }),
        ).toHaveAttribute("aria-checked", "false");
    });

    it("tells a member who sets them, and offers no switches", () => {
        state.scope = { kind: "managed", orgName: "Acme LLP" };
        render(<FeaturesPage />);

        expect(
            screen.getByText("Managed by your organization"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Features in Acme LLP are set by its owners and admins for everyone working there.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("switch")).toBeNull();
    });
});
