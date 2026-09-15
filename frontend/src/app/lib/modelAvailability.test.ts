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
});

describe("providerLabel", () => {
    it("returns the display label for each provider", () => {
        expect(providerLabel("claude")).toBe("Anthropic (Claude)");
        expect(providerLabel("openai")).toBe("OpenAI");
        expect(providerLabel("openrouter")).toBe("OpenRouter");
        expect(providerLabel("vercel")).toBe("Vercel AI Gateway");
        expect(providerLabel("opencode-go")).toBe("OpenCode Go");
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

const gatewayKeys = (
    gateway: {
        available?: boolean;
        label?: string;
        models?: { id: string; available: boolean }[];
    } | null,
): ApiKeyState =>
    ({
        ...keys({}),
        ...(gateway
            ? {
                  gateway: {
                      provider: "gateway" as const,
                      label: gateway.label ?? "Bifrost",
                      available: gateway.available ?? true,
                      defaultModel: null,
                      models: (gateway.models ?? []).map((model) => ({
                          id: model.id,
                          label: model.id,
                          group: "Gateway",
                          source: "gateway",
                          provider: "gateway" as const,
                          available: model.available,
                      })),
                  },
              }
            : {}),
    }) as ApiKeyState;

describe("gateway models", () => {
    it("resolves any gateway/-prefixed id without consulting SETTINGS_MODELS", () => {
        // Gateway models come from the deployment's catalog at runtime, so
        // like ollama the prefix alone has to be enough.
        expect(getModelProvider("gateway/gpt-5.6-sol")).toBe("gateway");
        expect(getModelProvider("gateway/some-deployment-model")).toBe(
            "gateway",
        );
    });

    it("treats the gateway provider as available only when the deployment says so", () => {
        expect(
            isProviderAvailable("gateway", gatewayKeys({ available: true })),
        ).toBe(true);
        expect(
            isProviderAvailable("gateway", gatewayKeys({ available: false })),
        ).toBe(false);
        // No gateway configured at all.
        expect(isProviderAvailable("gateway", gatewayKeys(null))).toBe(false);
    });

    it("marks an individual gateway model available only when the catalog lists it as available", () => {
        const apiKeys = gatewayKeys({
            models: [
                { id: "gateway/ready", available: true },
                { id: "gateway/disabled", available: false },
            ],
        });
        expect(isModelAvailable("gateway/ready", apiKeys)).toBe(true);
        expect(isModelAvailable("gateway/disabled", apiKeys)).toBe(false);
        expect(isModelAvailable("gateway/unknown", apiKeys)).toBe(false);
        expect(isModelAvailable("gateway/ready", gatewayKeys(null))).toBe(
            false,
        );
    });

    it("labels the gateway with the deployment's own name, falling back to a generic one", () => {
        expect(providerLabel("gateway", "Bifrost")).toBe("Bifrost");
        expect(providerLabel("gateway")).toBe("Gateway");
    });
});
