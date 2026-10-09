import {
    SETTINGS_MODELS,
    canonicalModelId,
    type ModelOption,
} from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export type ModelProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "mistral"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "bedrock"
    | "azure"
    | "azure-foundry"
    | "vertex"
    | "xai"
    | "custom"
    | "ollama";

export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("ollama/")) return "ollama"; // dynamic, not in the static list
    if (modelId.startsWith("openrouter/")) return "openrouter";
    if (modelId.startsWith("vercel/")) return "vercel";
    if (modelId.startsWith("opencode-go/")) return "opencode-go";
    if (modelId.startsWith("bedrock/")) return "bedrock";
    if (modelId.startsWith("azure/")) return "azure";
    if (modelId.startsWith("azure-foundry/")) return "azure-foundry";
    if (modelId.startsWith("vertex/")) return "vertex";
    if (modelId.startsWith("xai/")) return "xai";
    if (modelId.startsWith("custom/")) return "custom";
    const model = SETTINGS_MODELS.find((m) => m.id === canonicalModelId(modelId));
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
    configuredModelIds: readonly string[] = [],
): boolean {
    if (configuredModelIds.includes(modelId)) return true;
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    if (provider === "ollama") return true; // local, no key needed
    return !!apiKeys[provider]?.configured && apiKeys[provider]?.enabled !== false;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "mistral") return "Mistral AI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "bedrock") return "Amazon Bedrock";
    if (provider === "azure") return "Azure OpenAI";
    if (provider === "azure-foundry") return "Azure AI Foundry";
    if (provider === "vertex") return "Google Vertex AI";
    if (provider === "xai") return "xAI";
    if (provider === "custom") return "OpenAI-compatible endpoint";
    if (provider === "ollama") return "Local (Ollama)";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "Mistral AI") return "mistral";
    if (group === "OpenRouter") return "openrouter";
    if (group === "Vercel AI Gateway") return "vercel";
    if (group === "OpenCode Go") return "opencode-go";
    if (group === "Local") return "ollama";
    return "gemini";
}
