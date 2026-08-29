import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    getOpenRouterModels,
    getOpenCodeGoModels,
    updateOpenRouterModels,
    updateOpenCodeGoModels,
    openCodeGoConfigured,
} = vi.hoisted(() => ({
    getOpenRouterModels: vi.fn(),
    getOpenCodeGoModels: vi.fn(),
    updateOpenRouterModels: vi.fn(),
    updateOpenCodeGoModels: vi.fn(),
    openCodeGoConfigured: { value: false },
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getOpenRouterModels,
    getVercelModels: vi.fn().mockResolvedValue([]),
    getOrcaRouterModels: vi.fn().mockResolvedValue([]),
    getOpenCodeGoModels,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            apiKeys: {
                openrouter: { configured: true, source: "user" },
                orcarouter: { configured: false, source: null },
                vercel: { configured: false, source: null },
                "opencode-go": {
                    configured: openCodeGoConfigured.value,
                    source: openCodeGoConfigured.value ? "user" : null,
                },
            },
            openRouterModels: ["anthropic/claude-sonnet-4.5"],
            orcaRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
        },
        updateOpenRouterModels,
        updateOrcaRouterModels: vi.fn(),
        updateVercelModels: vi.fn(),
        updateOpenCodeGoModels,
    }),
}));

import {
    RouterSettingsSection,
    normalizeTypedModelId,
} from "./RouterSettingsSection";

describe("RouterSettingsSection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        openCodeGoConfigured.value = false;
        getOpenCodeGoModels.mockResolvedValue([
            { id: "glm-5", label: "GLM-5" },
        ]);
        getOpenRouterModels.mockResolvedValue([
            {
                id: "openai/gpt-5.4",
                label: "GPT 5.4",
                pricing: {
                    input: "0.00000125",
                    output: "0.00001",
                },
            },
            {
                id: "anthropic/claude-sonnet-4.5",
                label: "Claude Sonnet 4.5",
            },
            {
                id: "qwen/qwen-2.5-72b-instruct",
                label: "Qwen 2.5 72B Instruct",
            },
        ]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("shows matching catalog entries above a full-width typeahead", async () => {
        render(<RouterSettingsSection />);
        const input = screen.getByPlaceholderText(
            "e.g. anthropic/claude-sonnet-5",
        );

        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());
        fireEvent.change(input, { target: { value: "gpt" } });

        await screen.findByText("GPT 5.4");
        expect(
            screen.getByText("$1.25/M input · $10/M output"),
        ).toBeInTheDocument();
        expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add" })).toBeNull();

        const dropdown = screen.getByTestId("openrouter-model-catalog");
        expect(dropdown).toHaveClass("bottom-full", "left-0", "w-full");
    });

    it("opens and closes the catalog from the chevron", async () => {
        render(<RouterSettingsSection />);
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        const chevron = screen.getByRole("button", {
            name: "Choose OpenRouter model",
        });
        fireEvent.click(chevron);
        expect(
            screen.getByTestId("openrouter-model-catalog"),
        ).toBeInTheDocument();

        fireEvent.click(chevron);
        expect(
            screen.queryByTestId("openrouter-model-catalog"),
        ).not.toBeInTheDocument();
    });

    it("supports keyboard navigation and selection from the model field", async () => {
        updateOpenRouterModels.mockResolvedValue(true);
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input).toHaveAttribute("aria-expanded", "true");
        expect(input).toHaveAttribute(
            "aria-activedescendant",
            "openrouter-model-catalog-option-0",
        );

        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(updateOpenRouterModels).toHaveBeenCalledWith([
                "anthropic/claude-sonnet-4.5",
                "openai/gpt-5.4",
            ]),
        );
    });

    it("adds the typed id verbatim even when it substring-matches a catalog row", async () => {
        // Typing the full valid id "qwen/qwen-2" also matches the catalog's
        // "qwen/qwen-2.5-72b-instruct". Enter must add what was typed, not
        // the highlighted lookalike.
        updateOpenRouterModels.mockResolvedValue(true);
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.change(input, { target: { value: "qwen/qwen-2" } });
        // Typing never claims a highlight …
        expect(input).not.toHaveAttribute("aria-activedescendant");
        // … and the add-verbatim hint shows although catalog rows match.
        expect(screen.getByText("Qwen 2.5 72B Instruct")).toBeInTheDocument();
        expect(
            screen.getByText("Press Enter to add this model ID."),
        ).toBeInTheDocument();

        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(updateOpenRouterModels).toHaveBeenCalledWith([
                "anthropic/claude-sonnet-4.5",
                "qwen/qwen-2",
            ]),
        );
    });

    it("explains why Enter did nothing while the text is not id-shaped", async () => {
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.change(input, { target: { value: "qwen" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(updateOpenRouterModels).not.toHaveBeenCalled();
        // The search text stays so the user can keep narrowing the catalog…
        expect(input).toHaveValue("qwen");
        // …but silence would read as a broken key. Say what is wrong.
        expect(
            screen.getByText(/is not a model ID/),
        ).toBeInTheDocument();
    });

    it("rejects an over-long typed id client-side with a length message", async () => {
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.change(input, {
            target: { value: `vendor/${"m".repeat(220)}` },
        });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(updateOpenRouterModels).not.toHaveBeenCalled();
        expect(
            screen.getByText("Model IDs are at most 200 characters."),
        ).toBeInTheDocument();
    });

    it("keeps the add-verbatim hint outside the listbox", async () => {
        // ARIA: a listbox may only contain option/group children. A stray div
        // inside it makes the option count and index reported to assistive
        // tech disagree with what aria-activedescendant points at.
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.change(input, { target: { value: "qwen/qwen-2" } });

        const listbox = screen.getByRole("listbox", {
            name: "OpenRouter model catalog",
        });
        const hint = screen.getByText("Press Enter to add this model ID.");
        expect(listbox.contains(hint)).toBe(false);
        for (const child of Array.from(listbox.children)) {
            expect(child.getAttribute("role")).toBe("option");
        }
    });

    it("adds a router-slug catalog id verbatim instead of rejecting it", async () => {
        // OpenRouter's catalog contains "openrouter/auto". Stripping the
        // router prefix before validating leaves "auto", which is not
        // vendor/model shaped, so the add used to fail with an error.
        updateOpenRouterModels.mockResolvedValue(true);
        render(<RouterSettingsSection />);
        const input = screen.getByRole("combobox", {
            name: "OpenRouter models",
        });
        await waitFor(() => expect(getOpenRouterModels).toHaveBeenCalled());

        fireEvent.change(input, { target: { value: "openrouter/auto" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() =>
            expect(updateOpenRouterModels).toHaveBeenCalledWith([
                "anthropic/claude-sonnet-4.5",
                "openrouter/auto",
            ]),
        );
    });

    it("renders saved models with the option pill primitive", () => {
        render(<RouterSettingsSection />);

        const pill = screen.getByRole("button", {
            name: "Remove anthropic/claude-sonnet-4.5",
        });
        expect(pill).toHaveAttribute("data-slot", "option-pill");
        expect(pill).toHaveClass("rounded-full", "text-xs");
    });
});

describe("normalizeTypedModelId", () => {
    it("keeps router-slug catalog ids verbatim", () => {
        expect(normalizeTypedModelId("openrouter/auto", "openrouter")).toBe(
            "openrouter/auto",
        );
        expect(normalizeTypedModelId("vercel/v0-1.5-md", "vercel")).toBe(
            "vercel/v0-1.5-md",
        );
    });

    it("strips the router prefix only when the remainder is a full id", () => {
        expect(
            normalizeTypedModelId(
                " openrouter/deepseek/deepseek-v3 ",
                "openrouter",
            ),
        ).toBe("deepseek/deepseek-v3");
        expect(normalizeTypedModelId("openai/gpt-5.4", "openrouter")).toBe(
            "openai/gpt-5.4",
        );
    });

    it("returns null for text that is not id-shaped", () => {
        expect(normalizeTypedModelId("auto", "openrouter")).toBeNull();
        expect(normalizeTypedModelId("two words/x", "openrouter")).toBeNull();
        expect(normalizeTypedModelId("", "openrouter")).toBeNull();
    });

    it("enforces the backend's 200-character model_id limit", () => {
        // user_router_models CHECKs char_length(model_id) between 1 and 200,
        // so anything longer is a guaranteed 400 — catch it where the user is
        // still looking at the box they typed it into.
        const at200 = `vendor/${"m".repeat(193)}`;
        expect(at200).toHaveLength(200);
        expect(normalizeTypedModelId(at200, "openrouter")).toBe(at200);
        expect(
            normalizeTypedModelId(`${at200}m`, "openrouter"),
        ).toBeNull();
    });
});

describe("RouterSettingsSection with OpenCode Go configured", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        openCodeGoConfigured.value = true;
        getOpenRouterModels.mockResolvedValue([]);
        getOpenCodeGoModels.mockResolvedValue([
            { id: "glm-5", label: "GLM-5" },
        ]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        openCodeGoConfigured.value = false;
    });

    it("saves a typed bare model name, which the other routers reject", async () => {
        updateOpenCodeGoModels.mockResolvedValue(true);
        render(<RouterSettingsSection />);
        const input = screen.getByPlaceholderText("e.g. glm-5");

        await waitFor(() => expect(getOpenCodeGoModels).toHaveBeenCalled());
        fireEvent.change(input, { target: { value: "opencode-go/kimi-k3" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() =>
            expect(updateOpenCodeGoModels).toHaveBeenCalledWith(["kimi-k3"]),
        );
        expect(updateOpenRouterModels).not.toHaveBeenCalled();
    });

    it("validates typed ids per router", () => {
        expect(normalizeTypedModelId("glm-5", "opencode-go")).toBe("glm-5");
        expect(normalizeTypedModelId("glm-5", "openrouter")).toBeNull();
        expect(normalizeTypedModelId("not a model", "opencode-go")).toBeNull();
    });
});
