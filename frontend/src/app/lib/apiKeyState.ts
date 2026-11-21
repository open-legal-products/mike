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
 * Whether a server payload carries a key status at all. A forked server, or
 * a proxy or misrouted API URL answering 200 with some other body, can leave
 * it out; then the client cannot tell which providers have keys.
 */
export function hasApiKeyStatus(status: unknown): status is ApiKeyStatus {
    return typeof status === "object" && status !== null && !Array.isArray(status);
}

/**
 * The server's key status as the per-provider state the model pickers read.
 * A provider it does not mention is not configured, and a missing status
 * mentions none. Callers that must not read that as "no keys" check
 * `hasApiKeyStatus` first.
 */
export function apiKeyStateFromStatus(
    input: ApiKeyStatus | null | undefined,
): ApiKeyState {
    const status: Partial<ApiKeyStatus> = hasApiKeyStatus(input) ? input : {};
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
