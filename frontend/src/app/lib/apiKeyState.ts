import type { ApiKeyProvider, ApiKeyState, ApiKeyStatus } from "./mikeApi";

export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "mistral",
    "openrouter",
    "vercel",
    "opencode-go",
    "bedrock",
    "azure",
    "azure-foundry",
    "vertex",
    "xai",
    "custom",
    "courtlistener",
    "brave",
    "tavily",
    "deepseek",
];

/**
 * The server's key status as the per-provider state the model pickers read.
 * A provider it does not mention is not configured.
 */
export function apiKeyStateFromStatus(status: ApiKeyStatus): ApiKeyState {
    const state = {} as ApiKeyState;
    for (const provider of API_KEY_PROVIDERS) {
        state[provider] = {
            configured: !!status[provider],
            enabled: status.enabled?.[provider] !== false,
            source:
                status.sources?.[provider] ??
                (status[provider] ? "user" : null),
        };
    }
    return state;
}
