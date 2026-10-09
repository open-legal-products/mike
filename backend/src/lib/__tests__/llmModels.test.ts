import { describe, it, expect } from "vitest";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_MAIN_MODELS,
    MISTRAL_MAIN_MODELS,
    LEGACY_MODEL_IDS,
    CLAUDE_MID_MODELS,
    GEMINI_MID_MODELS,
    OPENAI_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    OPENAI_LOW_MODELS,
    providerForModel,
    resolveModel,
    openRouterModelId,
    vercelModelId,
    openCodeGoModelId,
    isOpenCodeGoChatCompletionsModel,
    isOpenCodeGoMessagesModel,
    isSupportedOpenCodeGoModel,
    normalizeReasoningLevelForModel,
    reasoningLevelsForModel,
    isAzureFoundryClaudeDeployment,
    azureFoundryDeploymentName,
    vertexModelId,
    vertexModelProtocol,
} from "../llm/models";

// ---------------------------------------------------------------------------
// providerForModel
// ---------------------------------------------------------------------------

describe("providerForModel", () => {
    it("routes bedrock/ and azure/ ids to the cloud platforms", () => {
        expect(providerForModel("bedrock/us.anthropic.claude-opus-5-5")).toBe(
            "bedrock",
        );
        expect(providerForModel("bedrock/meta.llama4-maverick-v1:0")).toBe(
            "bedrock",
        );
        expect(providerForModel("azure/gpt-6.1-sol")).toBe("azure");
    });

    it("routes the Foundry, Vertex, xAI and custom-endpoint prefixes", () => {
        // "azure-foundry/" must not be read as an Azure OpenAI deployment.
        expect(providerForModel("azure-foundry/claude-opus-5-5")).toBe(
            "azure-foundry",
        );
        expect(providerForModel("vertex/gemini-3.1-pro-preview")).toBe(
            "vertex",
        );
        expect(providerForModel("xai/grok-4.3")).toBe("xai");
        expect(providerForModel("custom/gpt-6.1-sol")).toBe("custom");
    });

    it("picks a Vertex protocol and a Foundry protocol from the id", () => {
        expect(vertexModelProtocol("vertex/claude-opus-5-5@20260101")).toBe(
            "anthropic",
        );
        expect(vertexModelProtocol("vertex/meta/llama-4-maverick-maas")).toBe(
            "maas",
        );
        expect(vertexModelProtocol("vertex/gemini-3.8-flash")).toBe("gemini");
        expect(
            isAzureFoundryClaudeDeployment("azure-foundry/Claude-Opus-prod"),
        ).toBe(true);
        expect(
            isAzureFoundryClaudeDeployment("azure-foundry/mistral-large-4"),
        ).toBe(false);
    });

    it("maps claude-* ids to the claude provider", () => {
        for (const model of [
            ...CLAUDE_MAIN_MODELS,
            ...CLAUDE_MID_MODELS,
            ...CLAUDE_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("claude");
        }
    });

    it("maps gemini-* ids to the gemini provider", () => {
        for (const model of [
            ...GEMINI_MAIN_MODELS,
            ...GEMINI_MID_MODELS,
            ...GEMINI_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("gemini");
        }
    });

    it("maps gpt-* ids to the openai provider", () => {
        for (const model of [
            ...OPENAI_MAIN_MODELS,
            ...OPENAI_MID_MODELS,
            ...OPENAI_LOW_MODELS,
        ]) {
            expect(providerForModel(model)).toBe("openai");
        }
    });

    it("maps namespaced OpenRouter ids to the openrouter provider", () => {
        expect(providerForModel("openrouter/anthropic/claude-sonnet-4.5")).toBe(
            "openrouter",
        );
    });

    it("maps namespaced Vercel AI Gateway ids to the vercel provider", () => {
        expect(providerForModel("vercel/anthropic/claude-sonnet-4.5")).toBe(
            "vercel",
        );
    });

    it("maps namespaced OpenCode Go ids to the opencode-go provider", () => {
        expect(providerForModel("opencode-go/glm-5")).toBe("opencode-go");
    });

    it("throws on an unknown model id", () => {
        expect(() => providerForModel("llama-3")).toThrow(/Unknown model id/);
        expect(() => providerForModel("")).toThrow(/Unknown model id/);
    });

    it("infers by prefix only, without validating against the catalog", () => {
        // Documents current behavior: any claude-/gemini-/gpt- prefix is
        // accepted even if the id is not a canonical model.
        expect(providerForModel("claude-nonexistent")).toBe("claude");
        expect(providerForModel("gpt-nonexistent")).toBe("openai");
    });
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

// Any string works as the fallback; resolveModel returns it untouched.
const FALLBACK = "gemini-3.8-flash";

describe("resolveModel", () => {
    it("returns a known model id unchanged", () => {
        expect(resolveModel("claude-opus-5-5", FALLBACK)).toBe(
            "claude-opus-5-5",
        );
        expect(resolveModel("gemini-3.8-flash", FALLBACK)).toBe(
            "gemini-3.8-flash",
        );
        expect(resolveModel("gpt-6-astra", FALLBACK)).toBe(
            "gpt-6-astra",
        );
    });

    it("accepts account-specific Bedrock and Azure ids by shape", () => {
        for (const model of [
            "bedrock/us.anthropic.claude-opus-5-5",
            "bedrock/arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
            "azure/my-gpt-deployment",
        ]) {
            expect(resolveModel(model, FALLBACK)).toBe(model);
        }
        expect(resolveModel("bedrock/", FALLBACK)).toBe(FALLBACK);
        expect(resolveModel("azure/has space", FALLBACK)).toBe(FALLBACK);
    });

    it("falls back for unknown model ids", () => {
        expect(resolveModel("gpt-3.5-turbo", FALLBACK)).toBe(
            FALLBACK,
        );
    });

    it("falls back for null, undefined, and empty ids", () => {
        expect(resolveModel(null, FALLBACK)).toBe(FALLBACK);
        expect(resolveModel(undefined, FALLBACK)).toBe(
            FALLBACK,
        );
        expect(resolveModel("", FALLBACK)).toBe(FALLBACK);
    });

    it("accepts models from every tier of the catalog", () => {
        const catalog = [
            ...CLAUDE_MAIN_MODELS,
            ...GEMINI_MAIN_MODELS,
            ...OPENAI_MAIN_MODELS,
            ...CLAUDE_MID_MODELS,
            ...GEMINI_MID_MODELS,
            ...OPENAI_MID_MODELS,
            ...CLAUDE_LOW_MODELS,
            ...GEMINI_LOW_MODELS,
            ...OPENAI_LOW_MODELS,
        ];
        for (const model of catalog) {
            expect(resolveModel(model, "fallback-model")).toBe(model);
        }
    });

    it("maps renamed legacy ids to their current equivalents", () => {
        // Stored preferences outlive catalog renames; without the mapping the
        // saved value silently degrades to the fallback.
        expect(
            resolveModel("gemini-3.1-flash-lite-preview", FALLBACK),
        ).toBe("gemini-3.5-flash-lite");
        expect(resolveModel("gpt-5.4-lite", FALLBACK)).toBe(
            "gpt-6-luna",
        );
    });

    it("accepts namespaced OpenRouter model ids", () => {
        expect(
            resolveModel(
                "openrouter/meta-llama/llama-4-maverick",
                FALLBACK,
            ),
        ).toBe("openrouter/meta-llama/llama-4-maverick");
        expect(resolveModel("openrouter/invalid", FALLBACK)).toBe(
            FALLBACK,
        );
    });

    it("accepts namespaced Vercel AI Gateway model ids", () => {
        expect(resolveModel("vercel/openai/gpt-5.4", FALLBACK)).toBe(
            "vercel/openai/gpt-5.4",
        );
        expect(resolveModel("vercel/invalid", FALLBACK)).toBe(
            FALLBACK,
        );
    });

    it("accepts OpenCode Go's single-segment model ids", () => {
        // Unlike the other two routers, OpenCode Go's catalog ids are bare
        // names — requiring a vendor/model pair would reject all of them.
        expect(resolveModel("opencode-go/glm-5", FALLBACK)).toBe(
            "opencode-go/glm-5",
        );
        expect(resolveModel("opencode-go/", FALLBACK)).toBe(
            FALLBACK,
        );
        expect(resolveModel("opencode-go/a b", FALLBACK)).toBe(
            FALLBACK,
        );
    });
});

describe("openCodeGoModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(openCodeGoModelId("opencode-go/glm-5")).toBe("glm-5");
        expect(openCodeGoModelId("glm-5")).toBe("glm-5");
    });
});

describe("OpenCode Go protocol classification", () => {
    it("classifies supported models and rejects unknown protocols", () => {
        expect(isOpenCodeGoChatCompletionsModel("opencode-go/glm-5.3")).toBe(
            true,
        );
        expect(isOpenCodeGoChatCompletionsModel("kimi-k3")).toBe(true);
        expect(isOpenCodeGoChatCompletionsModel("qwen3.8-max")).toBe(false);
        expect(isOpenCodeGoMessagesModel("opencode-go/qwen3.8-max")).toBe(
            true,
        );
        expect(isOpenCodeGoMessagesModel("minimax-m3")).toBe(true);
        expect(isSupportedOpenCodeGoModel("glm-5.3")).toBe(true);
        expect(isSupportedOpenCodeGoModel("qwen3.8-max")).toBe(true);
        expect(isSupportedOpenCodeGoModel("gpt-5.6-luna")).toBe(false);
        expect(isSupportedOpenCodeGoModel("future-model")).toBe(false);
    });
});

describe("openRouterModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(openRouterModelId("openrouter/openai/gpt-5.4")).toBe(
            "openai/gpt-5.4",
        );
    });

    it("preserves catalog ids that begin with the router's own slug", () => {
        // "openrouter/auto" is a real OpenRouter catalog id, so the app-level
        // id is "openrouter/openrouter/auto": resolveModel must accept it and
        // the adapter must strip exactly one namespace segment.
        expect(
            resolveModel("openrouter/openrouter/auto", FALLBACK),
        ).toBe("openrouter/openrouter/auto");
        expect(openRouterModelId("openrouter/openrouter/auto")).toBe(
            "openrouter/auto",
        );
    });
});

describe("vercelModelId", () => {
    it("removes only the internal provider namespace", () => {
        expect(vercelModelId("vercel/openai/gpt-5.4")).toBe("openai/gpt-5.4");
    });

    it("preserves catalog ids that begin with the router's own slug", () => {
        expect(resolveModel("vercel/vercel/v0-1.5-md", FALLBACK)).toBe(
            "vercel/vercel/v0-1.5-md",
        );
        expect(vercelModelId("vercel/vercel/v0-1.5-md")).toBe(
            "vercel/v0-1.5-md",
        );
    });
});

describe("explicit protocols for Vertex and Foundry ids", () => {
    it("override the protocol inferred from the name", () => {
        // A Foundry Claude deployment that was not named after its model.
        expect(
            isAzureFoundryClaudeDeployment("azure-foundry/anthropic:prod-sonnet"),
        ).toBe(true);
        expect(
            isAzureFoundryClaudeDeployment("azure-foundry/openai:claude-router"),
        ).toBe(false);
        expect(azureFoundryDeploymentName("azure-foundry/anthropic:prod-sonnet")).toBe(
            "prod-sonnet",
        );
        // A Vertex partner model with no publisher/ prefix.
        expect(vertexModelProtocol("vertex/openai:mistral-large-2411")).toBe(
            "maas",
        );
        expect(vertexModelProtocol("vertex/gemini:claude-lookalike")).toBe(
            "gemini",
        );
        expect(vertexModelProtocol("vertex/anthropic:sonnet-pinned")).toBe(
            "anthropic",
        );
        expect(vertexModelId("vertex/openai:mistral-large-2411")).toBe(
            "mistral-large-2411",
        );
    });

    it("do not hide the model from reasoning-level rules", () => {
        expect(
            reasoningLevelsForModel("azure-foundry/anthropic:claude-opus-5-5"),
        ).not.toContain("none");
    });
});

describe("resolveModel for account-specific providers", () => {
    it("accepts the new prefixes by shape and rejects malformed ids", () => {
        for (const id of [
            "azure-foundry/claude-opus-5-5",
            "vertex/claude-opus-5-5@20260101",
            "vertex/meta/llama-4-maverick-maas",
            "xai/grok-4.3",
            "custom/deepseek/deepseek-v4",
        ]) {
            expect(resolveModel(id, "fallback")).toBe(id);
        }
        expect(resolveModel("vertex/", "fallback")).toBe("fallback");
        expect(resolveModel("custom/has space", "fallback")).toBe("fallback");
    });
});

describe("reasoningLevelsForModel", () => {
    it("recognizes Claude behind Vertex and Foundry ids", () => {
        for (const model of [
            "vertex/claude-opus-5-5@20260101",
            "vertex/claude-opus-5-5",
            "azure-foundry/claude-opus-5-5",
        ]) {
            expect(reasoningLevelsForModel(model)).not.toContain("none");
        }
    });

    it("recognizes Claude behind Bedrock ids, which cannot disable thinking", () => {
        for (const model of [
            "bedrock/anthropic.claude-opus-5-5",
            "bedrock/us.anthropic.claude-opus-5-5",
            "bedrock/global.anthropic.claude-fable-5-1-v1:0",
            "bedrock/us-gov.anthropic.claude-opus-5-5",
            "bedrock/arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
        ]) {
            expect(reasoningLevelsForModel(model)).not.toContain("none");
        }
        expect(
            reasoningLevelsForModel("bedrock/us.anthropic.claude-sonnet-5-5"),
        ).toContain("none");
    });

    it("uses the GPT-5.6 subset exposed by the provider", () => {
        expect(reasoningLevelsForModel("gpt-5.6-terra")).toEqual([
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ]);
        expect(
            reasoningLevelsForModel("openrouter/openai/gpt-5.6-sol"),
        ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    });

    it("excludes Max for GPT-5.4 and GPT-5.5", () => {
        const expected = ["none", "low", "medium", "high", "xhigh"];
        expect(reasoningLevelsForModel("gpt-5.5")).toEqual(expected);
        expect(reasoningLevelsForModel("gpt-5.4")).toEqual(expected);
        expect(
            reasoningLevelsForModel("vercel/openai/gpt-5.5"),
        ).toEqual(expected);
    });

    it("normalizes stale levels to the nearest supported value", () => {
        expect(normalizeReasoningLevelForModel("gemini-3.7-flash", "max")).toBe(
            "xhigh",
        );
    });
});


describe("catalog refresh", () => {
    it("migrates every removed id to a current model without crossing providers", () => {
        for (const [old, current] of Object.entries(LEGACY_MODEL_IDS)) {
            expect(resolveModel(old, "missing")).toBe(current);
            expect(resolveModel(current, "missing")).toBe(current);
            expect(providerForModel(old)).toBe(providerForModel(current));
        }
    });
    it("resolves every Mistral model as a direct provider", () => {
        for (const model of MISTRAL_MAIN_MODELS) {
            expect(resolveModel(model, "missing")).toBe(model);
            expect(providerForModel(model)).toBe("mistral");
        }
        expect(providerForModel("openrouter/mistralai/mistral-large-4")).toBe("openrouter");
    });
    it.each(["gpt-6-astra", "gpt-6.1-sol", "claude-fable-5-1", "claude-opus-5-5"])("never disables required reasoning for %s", (model) => {
        expect(reasoningLevelsForModel(model)).not.toContain("none");
        expect(normalizeReasoningLevelForModel(model, "none")).toBe("low");
    });
    it("offers Mistral's two supported reasoning levels", () => {
        expect(reasoningLevelsForModel("mistral-small-2603")).toEqual(["none", "high"]);
        expect(normalizeReasoningLevelForModel("mistral-small-2603", "xhigh")).toBe("high");
        expect(reasoningLevelsForModel("gpt-6-luna")).toContain("none");
        expect(reasoningLevelsForModel("gpt-6.1-sol")).toContain("max");
    });
});

// PR #608 regression: account-specific ids reach provider URLs (Vertex
// interpolates the model id into the request path unencoded), so resolveModel
// must not accept them "by shape". Preferences saved before the save-time
// check rely on this fallback. The full grammar is covered by
// byokValidationCases.test.ts; this pins resolveModel's use of it.
describe("resolveModel rejects path-unsafe account-specific ids", () => {
    it("falls back for a traversal id under every account-specific prefix", () => {
        const traversal =
            "claude/../../../../v1/projects/victim/locations/us-central1/endpoints/123:rawPredict?x=";
        for (const prefix of [
            "bedrock",
            "azure",
            "azure-foundry",
            "vertex",
            "xai",
            "custom",
        ]) {
            expect(resolveModel(`${prefix}/${traversal}`, "fallback"), prefix).toBe(
                "fallback",
            );
        }
        expect(resolveModel("vertex/meta/llama-4-maverick-maas", "fallback")).toBe(
            "vertex/meta/llama-4-maverick-maas",
        );
    });
});
