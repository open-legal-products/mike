import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/app/components/assistant/ModelToggle";
import type {
    ApiKeyState,
    PlaybookConfiguration,
} from "@/app/lib/mikeApi";
import { buildPlaybookModelOptions } from "./playbookModelOptions";

const catalog: ModelOption[] = [
    {
        id: "openrouter/anthropic/claude-sonnet-4",
        label: "Claude Sonnet 4",
        group: "OpenRouter",
    },
    { id: "ollama/qwen3.6", label: "qwen3.6 (local)", group: "Local" },
    { id: "custom-reviewer", label: "Custom Reviewer", group: "OpenAI" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
];

const configuration: PlaybookConfiguration = {
    availableModelIds: ["custom-reviewer"],
    defaultModel: "custom-reviewer",
};

const apiKeys = {
    openrouter: { configured: true, source: "user" },
    gemini: { configured: false, source: null },
} as ApiKeyState;

describe("buildPlaybookModelOptions", () => {
    it("includes server-approved, OpenRouter, and discovered Ollama models", () => {
        expect(
            buildPlaybookModelOptions(catalog, configuration, apiKeys),
        ).toEqual([
            {
                value: "openrouter/anthropic/claude-sonnet-4",
                label: "OpenRouter · Claude Sonnet 4",
            },
            {
                value: "ollama/qwen3.6",
                label: "Local · qwen3.6 (local)",
            },
            {
                value: "custom-reviewer",
                label: "OpenAI · Custom Reviewer",
            },
        ]);
    });
});
