import { describe, expect, it } from "vitest";
import {
    ROUTER_SLUGS,
    bedrockCatalogModel,
    isAllowedModelId,
    isRouterModelSelected,
    vertexCatalogModel,
    modelDisplayName,
    noModelsReason,
    routerModelOptions,
    routerProfileLists,
    routerSelections,
    type ProviderKeyState,
    type ProviderKeyStates,
} from "./modelCatalog";

describe("model display names", () => {
    it("formats provider model identifiers as readable names", () => {
        expect(modelDisplayName("anthropic/claude-sonnet-4-6")).toBe(
            "Claude Sonnet 4.6",
        );
        expect(
            modelDisplayName("openrouter/meta-llama/llama-3-3-70b-instruct"),
        ).toBe("Llama 3.3 70B Instruct");
    });

    it("uses the readable name for OpenRouter toggle options", () => {
        expect(routerModelOptions("openrouter", ["openai/gpt-4o-mini"])[0]).toMatchObject(
            {
                id: "openrouter/openai/gpt-4o-mini",
                label: "GPT 4o Mini",
            },
        );
    });

    it("uses the readable name for Vercel AI Gateway toggle options", () => {
        expect(routerModelOptions("vercel", ["openai/gpt-5.4"])[0]).toMatchObject({
            id: "vercel/openai/gpt-5.4",
            label: "GPT 5.4",
            group: "OpenAI",
            source: "Vercel",
        });
    });
});

describe("cloud platform options", () => {
    it("reads Bedrock ids as vendor/model without AWS-only decoration", () => {
        expect(bedrockCatalogModel("us.anthropic.claude-opus-5-5")).toBe(
            "anthropic/claude-opus-5-5",
        );
        expect(
            bedrockCatalogModel("anthropic.claude-sonnet-4-5-20250929-v1:0"),
        ).toBe("anthropic/claude-sonnet-4-5");
        expect(
            bedrockCatalogModel(
                "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
            ),
        ).toBe("anthropic/claude-opus-5-5");
        expect(bedrockCatalogModel("meta.llama4-maverick-17b-instruct-v1:0")).toBe(
            "meta/llama4-maverick-17b-instruct",
        );
        // An id that is not vendor.model is shown as typed.
        expect(bedrockCatalogModel("my-application-profile")).toBe(
            "my-application-profile",
        );
    });

    it("groups Bedrock models by maker and keeps the id verbatim", () => {
        expect(routerModelOptions("bedrock", ["us.anthropic.claude-opus-5-5"])[0]).toEqual({
            id: "bedrock/us.anthropic.claude-opus-5-5",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Bedrock",
        });
    });

    it("reads Vertex ids without the version pin or partner suffix", () => {
        expect(vertexCatalogModel("claude-opus-5-5@20260101")).toBe(
            "claude-opus-5-5",
        );
        expect(vertexCatalogModel("meta/llama-4-maverick-maas")).toBe(
            "meta/llama-4-maverick",
        );
        expect(routerModelOptions("vertex", ["claude-opus-5-5@20260101"])[0]).toEqual({
            id: "vertex/claude-opus-5-5@20260101",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Vertex",
        });
        expect(routerModelOptions("vertex", ["gemini-3.1-pro-preview"])[0]).toMatchObject({
            id: "vertex/gemini-3.1-pro-preview",
            group: "Google",
        });
    });

    it("labels Foundry, xAI and custom endpoint models by their source", () => {
        expect(routerModelOptions("azure-foundry", ["claude-opus-5-5"])[0]).toEqual({
            id: "azure-foundry/claude-opus-5-5",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Foundry",
        });
        expect(routerModelOptions("xai", ["grok-4.3"])[0]).toEqual({
            id: "xai/grok-4.3",
            label: "Grok 4.3",
            group: "xAI",
            source: "xAI",
        });
        expect(routerModelOptions("custom", ["deepseek/deepseek-v4"])[0]).toEqual({
            id: "custom/deepseek/deepseek-v4",
            label: "Deepseek V4",
            group: "DeepSeek",
            source: "Custom",
        });
    });

    it("labels Azure deployments by name", () => {
        expect(routerModelOptions("azure", ["gpt-6.1-sol"])[0]).toEqual({
            id: "azure/gpt-6.1-sol",
            label: "GPT 6.1 Sol",
            group: "OpenAI",
            source: "Azure",
        });
    });
});

describe("noModelsReason", () => {
    // GET /user/api-keys reports a switched-off saved key as
    // { configured: false, enabled: false, source: "user" }.
    const off = { configured: false, enabled: false, source: "user" } as const;
    const none = { configured: false, source: null } as const;
    const on = { configured: true, enabled: true, source: "user" } as const;
    const state = (entries: Record<string, ProviderKeyState>) =>
        ({
            claude: none,
            gemini: none,
            openai: none,
            mistral: none,
            openrouter: none,
            vercel: none,
            "opencode-go": none,
            bedrock: none,
            azure: none,
            "azure-foundry": none,
            vertex: none,
            xai: none,
            custom: none,
            courtlistener: none,
            ...entries,
        }) satisfies ProviderKeyStates;

    it("asks to turn a provider back on when every saved key is switched off", () => {
        expect(noModelsReason(state({ claude: off, bedrock: off }), {})).toBe(
            "providers-disabled",
        );
    });

    it("does not blame an empty selection on a router that is switched off", () => {
        expect(
            noModelsReason(state({ openrouter: off }), { openrouter: [] }),
        ).toBe("providers-disabled");
        expect(
            noModelsReason(
                state({ openrouter: { ...on, enabled: false } }),
                { openrouter: [] },
            ),
        ).toBe("providers-disabled");
    });

    it("still points at Model Selections for an enabled router with none saved", () => {
        expect(
            noModelsReason(state({ bedrock: on, claude: off }), { bedrock: [] }),
        ).toBe("router-models");
    });

    it("ignores a switched-off CourtListener key, which serves no models", () => {
        expect(noModelsReason(state({ courtlistener: off }), {})).toBe(
            "api-keys",
        );
    });
});

describe("router Model Selections", () => {
    it("reads every router's list from its profile field, defaulting to empty", () => {
        const selections = routerSelections({
            openRouterModels: ["openai/gpt-5.4"],
            azureFoundryModels: ["claude-opus-5-5"],
            // An older API, or a malformed response, is not a list.
            vertexModels: null,
        });
        expect(Object.keys(selections)).toEqual([...ROUTER_SLUGS]);
        expect(selections.openrouter).toEqual(["openai/gpt-5.4"]);
        expect(selections["azure-foundry"]).toEqual(["claude-opus-5-5"]);
        expect(selections.vertex).toEqual([]);
        expect(routerProfileLists({ xaiModels: ["grok-4.3"] })).toMatchObject({
            xaiModels: ["grok-4.3"],
            customModels: [],
        });
    });

    it("accepts a router model only while it is saved for that router", () => {
        const selections = routerSelections({ bedrockModels: ["us.anthropic.claude-opus-5-5"] });
        expect(
            isRouterModelSelected("bedrock/us.anthropic.claude-opus-5-5", selections),
        ).toBe(true);
        expect(isRouterModelSelected("bedrock/other", selections)).toBe(false);
        // "azure-foundry/" is not an "azure/" id.
        expect(isRouterModelSelected("azure-foundry/x", selections)).toBe(false);
        // Models that do not go through a router are not gated here.
        expect(isRouterModelSelected("claude-opus-5-5", selections)).toBe(true);
    });

    it("accepts a stored id only for a built-in, router or configured model", () => {
        expect(isAllowedModelId("xai/grok-5")).toBe(true);
        expect(isAllowedModelId("local-qwen")).toBe(false);
        expect(isAllowedModelId("local-qwen", ["local-qwen"])).toBe(true);
    });
});

describe("explicit cloud protocols", () => {
    it("keeps the protocol in the id but out of the label", () => {
        expect(routerModelOptions("azure-foundry", ["anthropic:prod-sonnet"])[0]).toMatchObject({
            id: "azure-foundry/anthropic:prod-sonnet",
            label: "Prod Sonnet",
        });
        expect(routerModelOptions("vertex", ["openai:mistral-large-2411"])[0]).toMatchObject({
            id: "vertex/openai:mistral-large-2411",
            label: "Mistral Large 2411",
            group: "Mistral AI",
        });
    });
});
