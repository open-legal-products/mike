import { describe, expect, it } from "vitest";
import {
    normalizeOptionalModelPreference,
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../modelSelection";
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
});
