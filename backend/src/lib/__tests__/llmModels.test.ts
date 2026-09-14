import { describe, it, expect } from "vitest";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    GEMINI_MID_MODELS,
    OPENAI_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    OPENAI_LOW_MODELS,
    SAMBANOVA_MAIN_MODELS,
    SAMBANOVA_MID_MODELS,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    providerForModel,
    resolveModel,
    openRouterModelId,
    vercelModelId,
    openCodeGoModelId,
    sambanovaModelId,
    isOpenCodeGoChatCompletionsModel,
    isOpenCodeGoMessagesModel,
    isSupportedOpenCodeGoModel,
    normalizeReasoningLevelForModel,
    reasoningLevelsForModel,
} from "../llm/models";

// ---------------------------------------------------------------------------
// providerForModel
// ---------------------------------------------------------------------------

describe("providerForModel", () => {
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

describe("resolveModel", () => {
    it("returns a known model id unchanged", () => {
        expect(resolveModel("claude-opus-5", DEFAULT_MAIN_MODEL)).toBe(
            "claude-opus-5",
        );
        expect(resolveModel("gemini-3.7-flash", DEFAULT_MAIN_MODEL)).toBe(
            "gemini-3.7-flash",
        );
        expect(resolveModel("gpt-5.6-sol", DEFAULT_MAIN_MODEL)).toBe(
            "gpt-5.6-sol",
        );
    });

    it("falls back for unknown model ids", () => {
        expect(resolveModel("gpt-3.5-turbo", DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
        );
    });

    it("falls back for null, undefined, and empty ids", () => {
        expect(resolveModel(null, DEFAULT_MAIN_MODEL)).toBe(DEFAULT_MAIN_MODEL);
        expect(resolveModel(undefined, DEFAULT_TABULAR_MODEL)).toBe(
            DEFAULT_TABULAR_MODEL,
        );
        expect(resolveModel("", DEFAULT_TITLE_MODEL)).toBe(DEFAULT_TITLE_MODEL);
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
            resolveModel("gemini-3.1-flash-lite-preview", DEFAULT_MAIN_MODEL),
        ).toBe("gemini-3.5-flash-lite");
        expect(resolveModel("gpt-5.4-lite", DEFAULT_MAIN_MODEL)).toBe(
            "gpt-5.4-mini",
        );
    });

    it("accepts namespaced OpenRouter model ids", () => {
        expect(
            resolveModel(
                "openrouter/meta-llama/llama-4-maverick",
                DEFAULT_MAIN_MODEL,
            ),
        ).toBe("openrouter/meta-llama/llama-4-maverick");
        expect(resolveModel("openrouter/invalid", DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
        );
    });

    it("accepts namespaced Vercel AI Gateway model ids", () => {
        expect(resolveModel("vercel/openai/gpt-5.4", DEFAULT_MAIN_MODEL)).toBe(
            "vercel/openai/gpt-5.4",
        );
        expect(resolveModel("vercel/invalid", DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
        );
    });

    it("accepts OpenCode Go's single-segment model ids", () => {
        // Unlike the other two routers, OpenCode Go's catalog ids are bare
        // names — requiring a vendor/model pair would reject all of them.
        expect(resolveModel("opencode-go/glm-5", DEFAULT_MAIN_MODEL)).toBe(
            "opencode-go/glm-5",
        );
        expect(resolveModel("opencode-go/", DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
        );
        expect(resolveModel("opencode-go/a b", DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
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
            resolveModel("openrouter/openrouter/auto", DEFAULT_MAIN_MODEL),
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
        expect(resolveModel("vercel/vercel/v0-1.5-md", DEFAULT_MAIN_MODEL)).toBe(
            "vercel/vercel/v0-1.5-md",
        );
        expect(vercelModelId("vercel/vercel/v0-1.5-md")).toBe(
            "vercel/v0-1.5-md",
        );
    });
});

// ---------------------------------------------------------------------------
// Default model sanity
// ---------------------------------------------------------------------------

describe("default models", () => {
    it("every default resolves to itself (defaults are in the catalog)", () => {
        expect(resolveModel(DEFAULT_MAIN_MODEL, "x")).toBe(DEFAULT_MAIN_MODEL);
        expect(resolveModel(DEFAULT_TITLE_MODEL, "x")).toBe(
            DEFAULT_TITLE_MODEL,
        );
        expect(resolveModel(DEFAULT_TABULAR_MODEL, "x")).toBe(
            DEFAULT_TABULAR_MODEL,
        );
    });

    it("every default has a resolvable provider", () => {
        // SambaNova is this deployment's primary provider, so every default
        // must land there — a default pointing at a provider whose key the
        // deployment does not ship is an immediate runtime failure.
        expect(providerForModel(DEFAULT_MAIN_MODEL)).toBe("sambanova");
        expect(providerForModel(DEFAULT_TITLE_MODEL)).toBe("sambanova");
        expect(providerForModel(DEFAULT_TABULAR_MODEL)).toBe("sambanova");
    });
});

describe("sambanova catalog", () => {
    it("infers the provider from the id prefix", () => {
        expect(providerForModel("sambanova/MiniMax-M3")).toBe("sambanova");
    });

    it("strips the prefix to the id the endpoint serves", () => {
        expect(sambanovaModelId("sambanova/MiniMax-M3")).toBe("MiniMax-M3");
    });

    it("accepts a live id that is not in the pinned catalog", () => {
        // The account's served models change without a redeploy, so an
        // unknown sambanova/* id must resolve rather than fall back.
        expect(resolveModel("sambanova/Some-New-Model", "x")).toBe(
            "sambanova/Some-New-Model",
        );
    });

    it("keeps Llama 3.3 70B out of the tool-carrying tiers", () => {
        const toolTiers: readonly string[] = [
            ...SAMBANOVA_MAIN_MODELS,
            ...SAMBANOVA_MID_MODELS,
        ];
        expect(toolTiers).not.toContain(
            "sambanova/Meta-Llama-3.3-70B-Instruct",
        );
    });
});

describe("reasoningLevelsForModel", () => {
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
