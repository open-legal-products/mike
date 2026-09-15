import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    normalizeApiKeyProvider,
    hasEnvApiKey,
    getUserApiKeys,
    getUserApiKeyStatus,
    saveUserApiKey,
} from "../user.apiKeyStore";

describe("normalizeApiKeyProvider", () => {
    it('returns "claude" for "claude"', () => {
        expect(normalizeApiKeyProvider("claude")).toBe("claude");
    });

    it('returns "openai" for "openai"', () => {
        expect(normalizeApiKeyProvider("openai")).toBe("openai");
    });

    it('returns "gemini" for "gemini"', () => {
        expect(normalizeApiKeyProvider("gemini")).toBe("gemini");
    });

    it("returns the supported router providers", () => {
        expect(normalizeApiKeyProvider("openrouter")).toBe("openrouter");
        expect(normalizeApiKeyProvider("vercel")).toBe("vercel");
        expect(normalizeApiKeyProvider("opencode-go")).toBe("opencode-go");
    });

    it("returns null for unknown provider strings", () => {
        expect(normalizeApiKeyProvider("unknown")).toBeNull();
        expect(normalizeApiKeyProvider("")).toBeNull();
        expect(normalizeApiKeyProvider("Claude")).toBeNull();
        expect(normalizeApiKeyProvider("OPENAI")).toBeNull();
    });
});

describe("hasEnvApiKey", () => {
    const envVars = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_API_KEY",
        "VERCEL_AI_GATEWAY_API_KEY",
        "OPENCODE_API_KEY",
        "USER_API_KEYS_ENCRYPTION_SECRET",
    ];

    // Clear before AND after each test so keys exported in the developer's
    // shell (or CI) can't leak into assertions.
    beforeEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    afterEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    it("returns true for claude when ANTHROPIC_API_KEY is set", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for claude when CLAUDE_API_KEY is set as fallback", () => {
        process.env.CLAUDE_API_KEY = "sk-claude-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for openai when OPENAI_API_KEY is set", () => {
        process.env.OPENAI_API_KEY = "sk-openai-test";
        expect(hasEnvApiKey("openai")).toBe(true);
    });

    it("returns true for gemini when GEMINI_API_KEY is set", () => {
        process.env.GEMINI_API_KEY = "gemini-key-test";
        expect(hasEnvApiKey("gemini")).toBe(true);
    });

    it("returns true for Vercel when AI_GATEWAY_API_KEY is set", () => {
        process.env.AI_GATEWAY_API_KEY = "vercel-key-test";
        expect(hasEnvApiKey("vercel")).toBe(true);
    });

    it("accepts VERCEL_AI_GATEWAY_API_KEY as a compatibility alias", () => {
        process.env.VERCEL_AI_GATEWAY_API_KEY = "vercel-key-test";
        expect(hasEnvApiKey("vercel")).toBe(true);
    });

    it("returns true for OpenCode Go when OPENCODE_API_KEY is set", () => {
        process.env.OPENCODE_API_KEY = "opencode-key-test";
        expect(hasEnvApiKey("opencode-go")).toBe(true);
    });

    it("returns false when no env key is set for the provider", () => {
        expect(hasEnvApiKey("claude")).toBe(false);
        expect(hasEnvApiKey("openai")).toBe(false);
        expect(hasEnvApiKey("gemini")).toBe(false);
    });

    it("ignores whitespace-only env values", () => {
        process.env.ANTHROPIC_API_KEY = "   ";
        expect(hasEnvApiKey("claude")).toBe(false);
    });
});

describe("user API key precedence", () => {
    it("uses a saved user key before an environment key", async () => {
        process.env.OPENAI_API_KEY = "environment-key";
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
        let savedRow: Record<string, unknown> | null = null;
        const db = {
            from: () => ({
                upsert: async (row: Record<string, unknown>) => {
                    savedRow = { ...row, provider: "openai" };
                    return { error: null };
                },
                select: () => ({
                    eq: async () => ({
                        data: savedRow ? [savedRow] : [],
                        error: null,
                    }),
                }),
            }),
        };

        await saveUserApiKey("user-1", "openai", "personal-key", db as never);

        await expect(getUserApiKeys("user-1", db as never)).resolves.toMatchObject({
            openai: "personal-key",
        });
        await expect(
            getUserApiKeyStatus("user-1", db as never),
        ).resolves.toMatchObject({
            openai: true,
            sources: { openai: "user" },
        });

        delete process.env.OPENAI_API_KEY;
        delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    });
});
