import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CLAUDE_CODE_DISABLED_DETAIL,
    hasApiKeyForModel,
    normalizeOptionalModelPreference,
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../modelSelection";
import { resetModelRegistryCache } from "../llm/registry";
import type { Db } from "../supabase";

const routerModels = {
    openrouter: ["anthropic/claude-sonnet-4.5"],
    vercel: [],
    "opencode-go": ["glm-5"],
};

describe("titleModelForChat", () => {
    it.each([
        ["claude-fable-5", "claude-haiku-4-5"],
        ["gemini-3.7-flash", "gemini-3.5-flash-lite"],
        ["gpt-5.6-sol", "gpt-5.6-luna"],
    ])(
        "uses the cheapest model from the %s provider",
        (chatModel, expected) => {
            expect(titleModelForChat(chatModel)).toBe(expected);
        },
    );

    it.each([
        "openrouter/anthropic/claude-sonnet-4.5",
        "vercel/openai/gpt-5.4",
        "opencode-go/glm-5",
        "ollama/llama3.2",
    ])("reuses dynamic model %s", (chatModel) => {
        expect(titleModelForChat(chatModel)).toBe(chatModel);
    });

    it("honors the saved title override", () => {
        expect(titleModelForChat("gpt-5.6-sol", "claude-haiku-4-5")).toBe(
            "claude-haiku-4-5",
        );
    });
});

describe("normalizeOptionalModelPreference", () => {
    it("returns null instead of inventing a default", () => {
        expect(normalizeOptionalModelPreference(null, routerModels)).toBeNull();
        expect(
            normalizeOptionalModelPreference("not-a-model", routerModels),
        ).toBeNull();
    });

    it("rejects a router model outside the saved allowlist", () => {
        expect(
            normalizeOptionalModelPreference(
                "openrouter/openai/gpt-5.4",
                routerModels,
            ),
        ).toBeNull();
    });
});

describe("resolveEffectiveReasoningLevel", () => {
    it("normalizes a stale level for the selected model before persistence", () => {
        expect(
            resolveEffectiveReasoningLevel({
                model: "gpt-5.6-terra",
                requested: "minimal",
            }),
        ).toBe("low");
        expect(
            resolveEffectiveReasoningLevel({
                model: "gpt-5.5",
                requested: "minimal",
            }),
        ).toBe("low");
        expect(
            resolveEffectiveReasoningLevel({
                model: "gemini-3.7-flash",
                requested: "max",
            }),
        ).toBe("xhigh");
    });
});

describe("resolveEffectiveChatModel", () => {
    const db = {} as Db;

    // Env stubs below must not leak into the sibling cases in this file.
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("uses an explicit request before persisted values", async () => {
        await expect(
            resolveEffectiveChatModel({
                requested: "gpt-5.6-luna",
                chatModel: "claude-fable-5",
                lastSelectedModel: "gemini-3.7-flash",
                apiKeys: { openai: "key", claude: "key", gemini: "key" },
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({
            ok: true,
            model: "gpt-5.6-luna",
            source: "request",
        });
    });

    it("falls back to last-selected when the saved chat model has no key", async () => {
        await expect(
            resolveEffectiveChatModel({
                chatModel: "gemini-3.7-flash",
                lastSelectedModel: "gpt-5.6-luna",
                apiKeys: { openai: "key" },
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({
            ok: true,
            model: "gpt-5.6-luna",
            source: "last_selected",
        });
    });

    it("requires selection when neither persisted model is usable", async () => {
        await expect(
            resolveEffectiveChatModel({
                apiKeys: {},
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({
            ok: false,
            code: "model_required",
        });
    });

    // A disabled Claude Code is a server setting, so it must not be reported
    // as a missing key: that code drives the "add your API key" prompts, and
    // there is no key for a subscription provider.
    it("reports a disabled Claude Code model as unavailable, not keyless", async () => {
        vi.stubEnv("CLAUDE_CODE_ENABLED", "");
        await expect(
            resolveEffectiveChatModel({
                requested: "claude-code/opus",
                apiKeys: {},
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({
            ok: false,
            status: 400,
            code: "model_unavailable",
            detail: CLAUDE_CODE_DISABLED_DETAIL,
        });
    });

    it("accepts a Claude Code model with no keys once enabled", async () => {
        vi.stubEnv("CLAUDE_CODE_ENABLED", "true");
        await expect(
            resolveEffectiveChatModel({
                requested: "claude-code/opus",
                apiKeys: {},
                userId: "user-1",
                db,
            }),
        ).resolves.toMatchObject({ ok: true, model: "claude-code/opus" });
    });
});

describe("configured model selection", () => {
    const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

    beforeEach(() => {
        process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
            models: [
                {
                    id: "keyless-compatible",
                    provider: "openai-compatible",
                    location: "cloud",
                    baseUrl: "https://models.example.test/v1",
                },
                {
                    id: "user-key-compatible",
                    provider: "openai-compatible",
                    location: "cloud",
                    baseUrl: "https://models.example.test/v1",
                    apiKeyProvider: "openai",
                },
            ],
        });
        resetModelRegistryCache();
    });

    afterEach(() => {
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
    });

    it("allows a keyless configured model", () => {
        expect(hasApiKeyForModel("keyless-compatible", {})).toBe(true);
    });

    it("requires a declared user key", () => {
        expect(hasApiKeyForModel("user-key-compatible", {})).toBe(false);
        expect(
            hasApiKeyForModel("user-key-compatible", { openai: "user-key" }),
        ).toBe(true);
    });

    it("reuses the configured chat model for title generation", () => {
        expect(titleModelForChat("keyless-compatible")).toBe(
            "keyless-compatible",
        );
    });
});
