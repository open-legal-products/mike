import { describe, expect, it } from "vitest";
import { API_KEY_PROVIDERS, apiKeyStateFromStatus } from "./apiKeyState";
import type { ApiKeyStatus } from "./mikeApi";

const status = (overrides: Partial<ApiKeyStatus>): ApiKeyStatus =>
    ({
        ...Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p, false])),
        ...overrides,
    }) as ApiKeyStatus;

describe("apiKeyStateFromStatus", () => {
    it("covers every provider, configured or not", () => {
        const state = apiKeyStateFromStatus(status({}));
        expect(Object.keys(state).sort()).toEqual([...API_KEY_PROVIDERS].sort());
        expect(state.claude).toEqual({
            configured: false,
            enabled: true,
            source: null,
        });
    });

    it("keeps whose key a provider runs on", () => {
        const state = apiKeyStateFromStatus(
            status({
                openai: true,
                claude: true,
                gemini: true,
                sources: { openai: "org", claude: "user", gemini: "env" },
            }),
        );
        expect(state.openai.source).toBe("org");
        expect(state.claude.source).toBe("user");
        expect(state.gemini.source).toBe("env");
    });

    it("reports a switched-off provider as not enabled", () => {
        const state = apiKeyStateFromStatus(
            status({
                openai: false,
                enabled: { openai: false },
                sources: { openai: "org" },
            }),
        );
        expect(state.openai).toEqual({
            configured: false,
            enabled: false,
            source: "org",
        });
    });

    it("treats a configured provider with no stated source as the caller's", () => {
        // An older server that predates `sources`.
        expect(apiKeyStateFromStatus(status({ mistral: true })).mistral.source).toBe(
            "user",
        );
    });
});
