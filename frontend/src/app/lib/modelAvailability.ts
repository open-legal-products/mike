import {
    SETTINGS_MODELS,
    type ModelOption,
} from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export type ModelProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "orcarouter"
    | "vercel"
    | "opencode-go"
    | "ollama";

export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("ollama/")) return "ollama"; // dynamic, not in the static list
    if (modelId.startsWith("openrouter/")) return "openrouter";
    if (modelId.startsWith("orcarouter/")) return "orcarouter";
    if (modelId.startsWith("vercel/")) return "vercel";
    if (modelId.startsWith("opencode-go/")) return "opencode-go";
    const model = SETTINGS_MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    if (provider === "ollama") return true; // local, no key needed
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "orcarouter") return "OrcaRouter";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "ollama") return "Local (Ollama)";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "OpenRouter") return "openrouter";
    if (group === "OrcaRouter") return "orcarouter";
    if (group === "Vercel AI Gateway") return "vercel";
    if (group === "OpenCode Go") return "opencode-go";
    if (group === "Local") return "ollama";
    return "gemini";
}
