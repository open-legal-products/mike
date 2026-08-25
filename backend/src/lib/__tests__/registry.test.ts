import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    apiKeyForConfiguredModel,
    configuredModelIds,
    configuredModelSummaries,
    getConfiguredModel,
    loadModelRegistry,
    resetModelRegistryCache,
    tolerateTextToolCalls,
} from "../llm/registry";
import { providerForModel, resolveModel } from "../llm/models";

const LOCAL_QWEN = {
    id: "local-qwen",
    label: "Local Qwen",
    provider: "openai-compatible",
    location: "local",
    apiModel: "qwen3-32b",
    baseUrl: "http://localhost:8000/v1",
};

const CLOUD_DEEPSEEK = {
    id: "cloud-deepseek",
    provider: "openai-compatible",
    location: "cloud",
    baseUrl: "https://api.example.test/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
};

function configure(value: unknown) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify(value);
    resetModelRegistryCache();
}

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;
const originalKey = process.env.DEEPSEEK_API_KEY;

beforeEach(() => {
    configure({ models: [LOCAL_QWEN, CLOUD_DEEPSEEK] });
});

afterEach(() => {
    if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    resetModelRegistryCache();
});

describe("loadModelRegistry", () => {
    it("returns an empty registry when nothing is configured", () => {
        delete process.env.MIKE_MODEL_CONFIG_JSON;
        resetModelRegistryCache();
        expect(loadModelRegistry()).toEqual({ models: [], committees: [] });
    });

    it("rejects invalid JSON with an actionable message", () => {
        process.env.MIKE_MODEL_CONFIG_JSON = "{not json";
        resetModelRegistryCache();
        expect(() => loadModelRegistry()).toThrow(
            /MIKE_MODEL_CONFIG_JSON is not valid JSON/,
        );
    });

    it("drops entries that are not declarable models", () => {
        configure({
            models: [
                LOCAL_QWEN,
                { id: "no-provider", location: "cloud" },
                { id: "hosted", provider: "claude", location: "cloud" },
                { provider: "openai-compatible", location: "cloud" },
            ],
        });
        expect(configuredModelIds()).toEqual(["local-qwen"]);
    });
});

describe("getConfiguredModel", () => {
    it("finds a declared model", () => {
        expect(getConfiguredModel("local-qwen")).toMatchObject({
            id: "local-qwen",
            apiModel: "qwen3-32b",
        });
    });

    it("returns null for anything undeclared", () => {
        expect(getConfiguredModel("claude-opus-5")).toBeNull();
    });
});

describe("configuredModelSummaries", () => {
    it("labels each entry, falling back to the id", () => {
        expect(configuredModelSummaries()).toEqual([
            {
                id: "local-qwen",
                label: "Local Qwen",
                provider: "openai-compatible",
                location: "local",
            },
            {
                id: "cloud-deepseek",
                label: "cloud-deepseek",
                provider: "openai-compatible",
                location: "cloud",
            },
        ]);
    });
});

describe("apiKeyForConfiguredModel", () => {
    it("prefers an inline key", () => {
        expect(
            apiKeyForConfiguredModel({ ...CLOUD_DEEPSEEK, apiKey: "inline" }),
        ).toBe("inline");
    });

    it("falls back to the named environment variable", () => {
        process.env.DEEPSEEK_API_KEY = "from-env";
        expect(apiKeyForConfiguredModel(CLOUD_DEEPSEEK)).toBe("from-env");
    });

    it("reads the user's key when the model names a provider slot", () => {
        expect(
            apiKeyForConfiguredModel(
                { ...CLOUD_DEEPSEEK, apiKeyProvider: "openai" },
                { openai: "user-key" },
            ),
        ).toBe("user-key");
    });

    it("returns null when no key is available", () => {
        delete process.env.DEEPSEEK_API_KEY;
        expect(apiKeyForConfiguredModel(CLOUD_DEEPSEEK)).toBeNull();
    });
});

describe("tolerateTextToolCalls", () => {
    it("defaults to on for local endpoints and off for cloud ones", () => {
        expect(tolerateTextToolCalls(LOCAL_QWEN)).toBe(true);
        expect(tolerateTextToolCalls(CLOUD_DEEPSEEK)).toBe(false);
    });

    it("honours an explicit override", () => {
        expect(
            tolerateTextToolCalls({
                ...LOCAL_QWEN,
                tolerateTextToolCalls: false,
            }),
        ).toBe(false);
    });
});

describe("model resolution", () => {
    it("routes a configured id to its provider", () => {
        expect(providerForModel("local-qwen")).toBe("openai-compatible");
    });

    it("keeps the static catalog working", () => {
        expect(providerForModel("claude-opus-5")).toBe("claude");
    });

    it("accepts a configured id as a saved preference", () => {
        expect(resolveModel("local-qwen", "gemini-3-flash-preview")).toBe(
            "local-qwen",
        );
    });

    it("falls back when the id is unknown", () => {
        expect(resolveModel("retired-model", "gemini-3-flash-preview")).toBe(
            "gemini-3-flash-preview",
        );
    });
});
