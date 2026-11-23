import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgPreferences } from "@/app/lib/mikeApi";

// In an organization's workspace the page edits the organization's model
// preferences, offered against its keys; a member is told who sets them.

const state = vi.hoisted(() => ({
    scope: { kind: "organization", orgId: "org-1", orgName: "Acme LLP" } as
        | { kind: "organization"; orgId: string; orgName: string }
        | { kind: "managed"; orgName: string },
    initial: null as unknown as OrgPreferences,
    save: vi.fn(),
    notifyError: vi.fn(),
    updateModelPreference: vi.fn(),
}));

vi.mock("@/app/hooks/useWorkspaceSettingsScope", () => ({
    useWorkspaceSettingsScope: () => state.scope,
}));

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

// The organization's keys: OpenAI only.
vi.mock("@/app/hooks/useModelApiKeys", () => ({
    useModelApiKeys: () => ({
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: true, source: "org" },
    }),
}));
vi.mock("@/app/hooks/useModelRouterSelections", () => ({
    useModelRouterSelections: () => ({}),
}));
vi.mock("@/app/hooks/useOllamaModels", () => ({ useOllamaModels: () => [] }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { tabularModel: "gemini-3-flash-preview", apiKeys: {} },
        updateModelPreference: state.updateModelPreference,
    }),
}));

vi.mock("@/app/lib/userFacingError", () => ({
    notifyError: state.notifyError,
}));

import ModelPreferencesPage from "./page";

beforeEach(() => {
    vi.clearAllMocks();
    state.scope = { kind: "organization", orgId: "org-1", orgName: "Acme LLP" };
    state.initial = {
        title_model: null,
        tabular_model: null,
        memory_curator_model: "gpt-5.4-mini",
        subagent_model: null,
        subagent_reasoning: null,
        quick_actions_visible: true,
        response_details_visible: false,
        web_search: { enabled: false, claude: "provider", openai: "provider", other: "off" },
    };
    state.save.mockImplementation(async (update: Partial<OrgPreferences>) => ({
        ...state.initial,
        ...update,
    }));
});

describe("ModelPreferencesPage in an organization's workspace", () => {
    it("shows the organization's preferences, not the caller's", () => {
        render(<ModelPreferencesPage />);
        // The organization's memory curation model; the caller's own tabular
        // default does not appear.
        expect(screen.getByText("GPT-6 Luna")).toBeInTheDocument();
        expect(screen.getByText("No default model")).toBeInTheDocument();
    });

    it("saves a change to the organization, not to the caller's profile", async () => {
        const user = userEvent.setup();
        render(<ModelPreferencesPage />);

        await user.click(screen.getByRole("button", { name: "GPT-6 Luna" }));
        await user.click(screen.getByText("GPT-6.1 Sol"));

        await waitFor(() =>
            expect(state.save).toHaveBeenCalledWith({
                memory_curator_model: "gpt-6.1-sol",
            }),
        );
        expect(state.updateModelPreference).not.toHaveBeenCalled();
    });

    it("reports a refused change and keeps the saved model", async () => {
        const refusal = new Error("refused");
        state.save.mockRejectedValueOnce(refusal);
        const user = userEvent.setup();
        render(<ModelPreferencesPage />);

        await user.click(screen.getByRole("button", { name: "GPT-6 Luna" }));
        await user.click(screen.getByText("GPT-6.1 Sol"));

        await waitFor(() =>
            expect(state.notifyError).toHaveBeenCalledWith(
                refusal,
                expect.objectContaining({
                    action: "change the memory curation model",
                }),
            ),
        );
        expect(
            screen.getByRole("button", { name: "GPT-6 Luna" }),
        ).toBeInTheDocument();
    });

    it("tells a member who sets them, and offers no choices", () => {
        state.scope = { kind: "managed", orgName: "Acme LLP" };
        render(<ModelPreferencesPage />);

        expect(
            screen.getByText(
                "Model preferences in Acme LLP are set by its owners and admins for everyone working there.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });
});
