import { afterEach, expect, it, vi } from "vitest";
import { completeWithProvider } from "./providers";
import { hasApiKeyForModel } from "../modelSelection";
import { azureCredentials, bedrockCredentials } from "./cloudProviders";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

it.each([
    ["openai", "gpt-6-astra", "OPENAI_API_KEY"],
    ["claude", "claude-fable-5-1", "ANTHROPIC_API_KEY"],
    ["openrouter", "openrouter/openai/gpt-4o", "OPENROUTER_API_KEY"],
    ["bedrock", "bedrock/amazon.nova-pro-v1:0", "AWS_BEARER_TOKEN_BEDROCK"],
    ["azure", "azure/gpt-4o", "AZURE_API_KEY"],
])("blocks a disabled %s provider even when a server key exists", async (provider, model, envName) => {
    vi.stubEnv(envName, "server-key");
    vi.stubEnv("BEDROCK_AWS_REGION", "us-east-1");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "contoso-openai");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const apiKeys = { disabledProviders: [provider] };

    expect(hasApiKeyForModel(model, apiKeys)).toBe(false);
    await expect(completeWithProvider({ model, user: "Test", apiKeys })).rejects.toThrow("provider is turned off");
    expect(fetchMock).not.toHaveBeenCalled();
    if (provider === "bedrock") expect(bedrockCredentials(apiKeys)).toBeNull();
    if (provider === "azure") expect(azureCredentials(apiKeys)).toBeNull();
});
