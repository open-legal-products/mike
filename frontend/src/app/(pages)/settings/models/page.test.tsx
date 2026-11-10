import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@mike/client";

const { updateModelPreference, configuredModels } = vi.hoisted(() => ({
    updateModelPreference: vi.fn(async () => true),
    configuredModels: [] as ModelOption[],
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => configuredModels,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            // Legacy id stored before the catalog rename.
            titleModel: "gemini-3.1-flash-lite-preview",
            tabularModel: "gemini-3-flash-preview",
            memoryCuratorModel: "gpt-5.4-mini",
            subagentModel: null,
            subagentReasoning: null,
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: true, source: "user" },
                openai: { configured: true, source: "user" },
                openrouter: { configured: false, source: null },
                vercel: { configured: false, source: null },
                "opencode-go": { configured: false, source: null },
                courtlistener: { configured: false, source: null },
            },
        },
        updateModelPreference,
    }),
}));

import ModelPreferencesPage from "./page";

describe("model preferences page legacy ids", () => {
    beforeEach(() => {
        updateModelPreference.mockClear();
        configuredModels.length = 0;
    });

    it("shows the renamed model for a stored legacy preference", () => {
        render(<ModelPreferencesPage />);

        // Without the LEGACY_MODEL_IDS mapping the stored title value
        // matches no option and the dropdown falls back to "Select a model".
        expect(screen.getByText("Gemini 3.5 Flash-Lite")).toBeInTheDocument();
        expect(screen.getByText("Memory curation model")).toBeInTheDocument();
        expect(screen.getByText("GPT-6 Luna")).toBeInTheDocument();
        expect(screen.queryByText("Select a model")).not.toBeInTheDocument();
    });

    it("saves a selected memory curation model", async () => {
        const user = userEvent.setup();
        render(<ModelPreferencesPage />);

        await user.click(screen.getByRole("button", { name: "GPT-6 Luna" }));
        await user.click(screen.getByText("GPT-6.1 Sol"));

        expect(updateModelPreference).toHaveBeenCalledWith(
            "memoryCuratorModel",
            "gpt-6.1-sol",
        );
    });

    it("saves subagent defaults from rows that start as chosen per task", async () => {
        const user = userEvent.setup();
        render(<ModelPreferencesPage />);
        const subagents = screen.getByRole("region", { name: "Subagents" });
        const [modelRow, reasoningRow] = within(subagents).getAllByRole(
            "button",
            { name: "Chosen per task" },
        );

        await user.click(modelRow);
        await user.click(screen.getByText("GPT-6.1 Sol"));
        await user.click(reasoningRow);
        await user.click(screen.getByText("Medium"));

        expect(updateModelPreference).toHaveBeenCalledWith(
            "subagentModel",
            "gpt-6.1-sol",
        );
        expect(updateModelPreference).toHaveBeenCalledWith(
            "subagentReasoning",
            "medium",
        );
    });

    it("preserves a configured endpoint that reuses a retired direct model id", () => {
        configuredModels.push({
            id: "gpt-5.4-mini",
            label: "Private endpoint",
            group: "OpenAI",
            source: "Configured",
        });
        render(<ModelPreferencesPage />);

        expect(
            screen.getByRole("button", { name: "Private endpoint" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("GPT-6 Luna")).not.toBeInTheDocument();
    });
});
