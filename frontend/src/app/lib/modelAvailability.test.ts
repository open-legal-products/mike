import { describe, expect, it } from "vitest";
import { SETTINGS_MODELS } from "../components/assistant/ModelToggle";
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
    openrouter?: boolean;
    vercel?: boolean;
    opencodego?: boolean;
}): ApiKeyState =>
    ({
        claude: { configured: !!configured.claude, source: null },
        gemini: { configured: !!configured.gemini, source: null },
        openai: { configured: !!configured.openai, source: null },
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
        expect(getModelProvider("claude-opus-5")).toBe("claude");
        expect(getModelProvider("gemini-3.7-flash")).toBe("gemini");
        expect(getModelProvider("gpt-5.6-sol")).toBe("openai");
        expect(getModelProvider("openrouter/openai/gpt-5.4")).toBe(
            "openrouter",
        );
        expect(getModelProvider("vercel/openai/gpt-5.4")).toBe("vercel");
        expect(getModelProvider("opencode-go/glm-5")).toBe("opencode-go");
    });

    it("resolves any ollama/-prefixed id without consulting SETTINGS_MODELS", () => {
        // Ollama models are discovered at runtime, so they can never appear
        // in the static list — the prefix alone must be enough.
        expect(getModelProvider("ollama/llama3.2")).toBe("ollama");
        expect(getModelProvider("ollama/some-brand-new-model")).toBe("ollama");
    });

    it("resolves claude-code/ ids to claude-code, never the claude provider", () => {
        expect(getModelProvider("claude-code/opus")).toBe("claude-code");
        expect(getModelProvider("claude-code/sonnet")).toBe("claude-code");
        expect(getModelProvider("claude-code/haiku")).toBe("claude-code");
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
        expect(isModelAvailable("claude-fable-5", keys({ claude: true }))).toBe(
            true,
        );
        expect(isModelAvailable("claude-fable-5", keys({ gemini: true }))).toBe(
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

    it("is true for ollama models even with no keys configured", () => {
        expect(isModelAvailable("ollama/llama3.2", keys({}))).toBe(true);
    });

    it("is true for claude-code models without an Anthropic key", () => {
        expect(isModelAvailable("claude-code/opus", keys({}))).toBe(true);
        expect(
            isModelAvailable("claude-code/haiku", keys({ gemini: true })),
        ).toBe(true);
    });
});

describe("isProviderAvailable", () => {
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

    it("treats claude-code as always available because a subscription needs no API key", () => {
        expect(isProviderAvailable("claude-code", keys({}))).toBe(true);
        expect(
            isProviderAvailable("claude-code", {} as unknown as ApiKeyState),
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
        expect(providerLabel("ollama")).toBe("Local (Ollama)");
        expect(providerLabel("claude-code")).toBe("Claude Code (subscription)");
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
        expect(modelGroupToProvider("Claude Code")).toBe("claude-code");
        expect(modelGroupToProvider("Google")).toBe("gemini");
    });
});
