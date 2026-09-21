import { afterEach, describe, expect, it, vi } from "vitest";

import { resetModelRegistryCache } from "../../../lib/llm/registry";
import { missingModelApiKey } from "../tabular.shared";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configure(model: Record<string, unknown>) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({ models: [model] });
    resetModelRegistryCache();
}

afterEach(() => {
    if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
    resetModelRegistryCache();
});

describe("configured tabular model authentication", () => {
    it("allows a cloud endpoint that declares no authentication source", () => {
        configure({
            id: "keyless-cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
        });

        expect(missingModelApiKey("keyless-cloud", {})).toBeNull();
    });

    it("rejects a configured endpoint when its declared key is unavailable", () => {
        configure({
            id: "user-key-cloud",
            label: "User Key Cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
            apiKeyProvider: "openai",
        });

        expect(missingModelApiKey("user-key-cloud", {})).toMatchObject({
            provider: "openai-compatible",
            model: "user-key-cloud",
        });
        expect(
            missingModelApiKey("user-key-cloud", { openai: "user-key" }),
        ).toBeNull();
    });
});

describe("Claude Code tabular authentication", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // missingModelApiKey feeds the "add your API key" popup. A subscription
    // provider has no key to add, so it must never answer through that path.
    it("never reports Claude Code as a missing key, enabled or not", () => {
        vi.stubEnv("CLAUDE_CODE_ENABLED", "true");
        expect(missingModelApiKey("claude-code/opus", {})).toBeNull();
        vi.stubEnv("CLAUDE_CODE_ENABLED", "");
        expect(missingModelApiKey("claude-code/opus", {})).toBeNull();
    });
});
