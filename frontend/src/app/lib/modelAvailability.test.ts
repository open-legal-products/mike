import { describe, expect, it } from "vitest";
import { SETTINGS_MODELS } from "@/shared/lib/modelCatalog";
import type { ApiKeyState } from "./mikeApi";
import {
    getModelProvider,
    isModelAvailable,
    isProviderAvailable,
    modelGroupToProvider,
    providerLabel,
} from "./modelAvailability";

const keys = (configured: {
    claude?: boolean;
    gemini?: boolean;
    openai?: boolean;
    mistral?: boolean;
    openrouter?: boolean;
    vercel?: boolean;
    opencodego?: boolean;
}): ApiKeyState =>
    ({
        claude: { configured: !!configured.claude, source: null },
        gemini: { configured: !!configured.gemini, source: null },
        openai: { configured: !!configured.openai, source: null },
        mistral: { configured: !!configured.mistral, source: null },
        openrouter: { configured: !!configured.openrouter, source: null },
        vercel: { configured: !!configured.vercel, source: null },
        "opencode-go": {
            configured: !!configured.opencodego,
            source: null,
        },
        courtlistener: { configured: false, source: null },
    }) as ApiKeyState;

describe("getModelProvider", () => {
    it("maps each settings model to a provider via its group", () => {
        expect(getModelProvider("claude-opus-5-5")).toBe("claude");
        expect(getModelProvider("gemini-3.8-flash")).toBe("gemini");
        expect(getModelProvider("gpt-6-astra")).toBe("openai");
        expect(getModelProvider("openrouter/openai/gpt-5.4")).toBe(
            "openrouter",
        );
        expect(getModelProvider("vercel/openai/gpt-5.4")).toBe("vercel");
        expect(getModelProvider("opencode-go/glm-5")).toBe("opencode-go");
        expect(
            getModelProvider("bedrock/us.anthropic.claude-opus-5-5"),
        ).toBe("bedrock");
        expect(getModelProvider("azure/gpt-6.1-sol")).toBe("azure");
        expect(getModelProvider("azure-foundry/claude-opus-5-5")).toBe(
            "azure-foundry",
        );
        expect(getModelProvider("vertex/gemini-3.1-pro-preview")).toBe(
            "vertex",
        );
        expect(getModelProvider("xai/grok-4.3")).toBe("xai");
        expect(getModelProvider("custom/my-model")).toBe("custom");
    });

    it("resolves any ollama/-prefixed id without consulting SETTINGS_MODELS", () => {
        // Ollama models are discovered at runtime, so they can never appear
        // in the static list — the prefix alone must be enough.
        expect(getModelProvider("ollama/llama3.2")).toBe("ollama");
        expect(getModelProvider("ollama/some-brand-new-model")).toBe("ollama");
    });

    it("resolves a provider for every model in SETTINGS_MODELS", () => {
        for (const model of SETTINGS_MODELS) {
            expect(getModelProvider(model.id)).not.toBeNull();
        }
    });

    it("returns null for an unknown model id", () => {
        expect(getModelProvider("not-a-model")).toBeNull();
    });
});

describe("isModelAvailable", () => {
    it("is true only when the model's provider has a configured key", () => {
        expect(isModelAvailable("claude-fable-5-1", keys({ claude: true }))).toBe(
            true,
        );
        expect(isModelAvailable("claude-fable-5-1", keys({ gemini: true }))).toBe(
            false,
        );
        expect(
            isModelAvailable(
                "openrouter/anthropic/claude-sonnet-4.5",
                keys({ openrouter: true }),
            ),
        ).toBe(true);
        expect(
            isModelAvailable(
                "vercel/anthropic/claude-sonnet-4.5",
                keys({ vercel: true }),
            ),
        ).toBe(true);
        expect(
            isModelAvailable("opencode-go/glm-5", keys({ opencodego: true })),
        ).toBe(true);
        // Each router gates on its own key, never a sibling's.
        expect(
            isModelAvailable("opencode-go/glm-5", keys({ vercel: true })),
        ).toBe(false);
    });

    it("is false for an unknown model regardless of keys", () => {
        expect(
            isModelAvailable(
                "not-a-model",
                keys({ claude: true, gemini: true, openai: true }),
            ),
        ).toBe(false);
    });

    it("accepts an authenticated configured model catalog id", () => {
        expect(
            isModelAvailable("local-qwen", keys({}), ["local-qwen"]),
        ).toBe(true);
    });

    it("is true for ollama models even with no keys configured", () => {
        expect(isModelAvailable("ollama/llama3.2", keys({}))).toBe(true);
    });
});

describe("isProviderAvailable", () => {
    it("excludes a disabled provider even when its key remains configured", () => {
        const state = keys({ openai: true, openrouter: true });
        state.openai.enabled = false;
        expect(isModelAvailable("gpt-6-astra", state)).toBe(false);
        expect(isModelAvailable("openrouter/openai/gpt-4o", state)).toBe(true);
    });
    it("reflects the configured flag for the provider", () => {
        expect(isProviderAvailable("openai", keys({ openai: true }))).toBe(
            true,
        );
        expect(isProviderAvailable("openai", keys({}))).toBe(false);
    });

    it("is false when the provider key is missing entirely", () => {
        expect(
            isProviderAvailable("claude", {} as unknown as ApiKeyState),
        ).toBe(false);
    });

    it("treats ollama as always available — local models need no API key", () => {
        expect(isProviderAvailable("ollama", keys({}))).toBe(true);
        expect(
            isProviderAvailable("ollama", {} as unknown as ApiKeyState),
        ).toBe(true);
    });
});

describe("providerLabel", () => {
    it("returns the display label for each provider", () => {
        expect(providerLabel("claude")).toBe("Anthropic (Claude)");
        expect(providerLabel("openai")).toBe("OpenAI");
        expect(providerLabel("openrouter")).toBe("OpenRouter");
        expect(providerLabel("vercel")).toBe("Vercel AI Gateway");
        expect(providerLabel("opencode-go")).toBe("OpenCode Go");
        expect(providerLabel("bedrock")).toBe("Amazon Bedrock");
        expect(providerLabel("azure")).toBe("Azure OpenAI");
        expect(providerLabel("azure-foundry")).toBe("Azure AI Foundry");
        expect(providerLabel("vertex")).toBe("Google Vertex AI");
        expect(providerLabel("xai")).toBe("xAI");
        expect(providerLabel("custom")).toBe("OpenAI-compatible endpoint");
        expect(providerLabel("ollama")).toBe("Local (Ollama)");
        expect(providerLabel("gemini")).toBe("Google (Gemini)");
    });
});

describe("modelGroupToProvider", () => {
    it("maps every model group to its provider id", () => {
        expect(modelGroupToProvider("Anthropic")).toBe("claude");
        expect(modelGroupToProvider("OpenAI")).toBe("openai");
        expect(modelGroupToProvider("OpenRouter")).toBe("openrouter");
        expect(modelGroupToProvider("OpenCode Go")).toBe("opencode-go");
        expect(modelGroupToProvider("Vercel AI Gateway")).toBe("vercel");
        expect(modelGroupToProvider("Local")).toBe("ollama");
        expect(modelGroupToProvider("Google")).toBe("gemini");
    });
});


it("makes direct Mistral available only with a Mistral key", () => {
    expect(isModelAvailable("mistral-large-4", keys({ mistral: true }))).toBe(true);
    expect(isModelAvailable("mistral-large-4", keys({ openai: true, openrouter: true }))).toBe(false);
    expect(providerLabel("mistral")).toBe("Mistral AI");
});
