import {
    apiKeyForConfiguredModel,
    configuredModelIds,
    getCommitteeModel,
    getConfiguredModel,
} from "./registry";
import type { CommitteeModel, Provider, UserApiKeys } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
] as const;
// Ollama models are detected dynamically (see GET /models/ollama). Any id of
// the form "ollama/<tag>" is valid — see providerForModel / resolveModel.

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MID_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MID_MODELS = ["gpt-5.6-terra", "gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.6-luna", "gpt-5.4-mini"] as const;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

// OpenCode Go publishes one catalog across three incompatible wire protocols:
// OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions. The live
// /models payload does not identify a model's protocol, so keep these lists
// fail-closed and in sync with https://opencode.ai/docs/go/#endpoints. A new
// catalog entry is not offered until Mike can actually speak its protocol.
export const OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS: ReadonlySet<string> =
    new Set([
        "glm-5",
        "glm-5.1",
        "glm-5.2",
        "glm-5.3",
        "kimi-k2.6",
        "kimi-k2.7-code",
        "kimi-k3",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "hy3",
    ]);

export const OPENCODE_GO_MESSAGES_MODEL_IDS: ReadonlySet<string> = new Set([
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
]);

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(
    model: string,
    committeeModels: CommitteeModel[] = [],
): Provider {
    // Deployment-declared models win over the prefix rules so an operator can
    // name a self-hosted endpoint whatever they like.
    const configured = getConfiguredModel(model);
    if (configured) return configured.provider;
    // A committee has no provider of its own; it is dispatched before any
    // adapter is built. Report the chair's so callers that label a provider
    // have something truthful to show.
    const committee = getCommitteeModel(model, committeeModels);
    if (committee) return providerForModel(committee.chair, committeeModels);
    if (model.startsWith("ollama")) return "ollama";
    if (model.startsWith("openrouter/")) return "openrouter";
    if (model.startsWith("vercel/")) return "vercel";
    if (model.startsWith("opencode-go/")) return "opencode-go";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

// Renamed/retired static ids → their current equivalents. Stored preferences
// and localStorage selections outlive catalog renames; mapping here keeps an
// old saved value working instead of silently kicking it to the fallback.
export const LEGACY_MODEL_IDS: Record<string, string> = {
    "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
    "gpt-5.4-lite": "gpt-5.4-mini",
};

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
    committeeModels: CommitteeModel[] = [],
): string {
    const canonical = id ? (LEGACY_MODEL_IDS[id] ?? id) : id;
    if (
        canonical &&
        (ALL_MODELS.has(canonical) ||
            getConfiguredModel(canonical) !== null ||
            getCommitteeModel(canonical, committeeModels) !== null ||
            canonical.startsWith("ollama/") ||
            /^(?:openrouter|vercel)\/[^\s/]+\/[^\s]+$/.test(canonical) ||
            // OpenCode Go's catalog ids are single-segment ("glm-5"), not the
            // vendor/model pairs OpenRouter and Vercel publish.
            /^opencode-go\/[^\s]+$/.test(canonical))
    )
        return canonical;
    return fallback;
}

export function openRouterModelId(model: string): string {
    return model.replace(/^openrouter\//, "");
}

export function vercelModelId(model: string): string {
    return model.replace(/^vercel\//, "");
}

export function openCodeGoModelId(model: string): string {
    return model.replace(/^opencode-go\//, "");
}

export function isOpenCodeGoChatCompletionsModel(model: string): boolean {
    return OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS.has(
        openCodeGoModelId(model),
    );
}

export function isOpenCodeGoMessagesModel(model: string): boolean {
    return OPENCODE_GO_MESSAGES_MODEL_IDS.has(openCodeGoModelId(model));
}

export function isSupportedOpenCodeGoModel(model: string): boolean {
    return (
        isOpenCodeGoChatCompletionsModel(model) ||
        isOpenCodeGoMessagesModel(model)
    );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const PROVIDER_KEY_ENV: Record<string, string[]> = {
    claude: ["ANTHROPIC_API_KEY"],
    gemini: ["GEMINI_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    vercel: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY"],
};

function providerKeyAvailable(
    provider: Provider,
    apiKeys?: UserApiKeys,
): boolean {
    // Ollama is local, and a configured endpoint's key is checked against its
    // own declaration rather than a provider-wide slot.
    if (provider === "ollama" || provider === "openai-compatible") return true;
    const userKey = apiKeys?.[provider as keyof UserApiKeys];
    if (typeof userKey === "string" && userKey.trim()) return true;
    return (PROVIDER_KEY_ENV[provider] ?? []).some((name) =>
        process.env[name]?.trim(),
    );
}

/**
 * The leaf models that stop a model — or every member and chair of a
 * committee — from running. Empty means it is usable.
 */
export function missingCommitteeApiKeyModels(
    model: string,
    apiKeys?: UserApiKeys,
    committeeModels: CommitteeModel[] = [],
    committeeStack: Set<string> = new Set(),
): string[] {
    const committee = getCommitteeModel(model, committeeModels);
    if (committee) {
        if (committeeStack.has(model)) return [model];
        const nextStack = new Set(committeeStack).add(model);
        const dependencies = [
            ...committee.members.map((member) =>
                typeof member === "string" ? member : member.model,
            ),
            committee.chair,
        ];
        return [
            ...new Set(
                dependencies.flatMap((dependency) =>
                    missingCommitteeApiKeyModels(
                        dependency,
                        apiKeys,
                        committeeModels,
                        nextStack,
                    ),
                ),
            ),
        ];
    }

    const configured = getConfiguredModel(model);
    if (configured) {
        // An endpoint that declares no key requirement authenticates however
        // the deployment set it up, commonly not at all.
        if (
            !configured.apiKey &&
            !configured.apiKeyProvider &&
            !configured.apiKeyEnv
        ) {
            return [];
        }
        return apiKeyForConfiguredModel(configured, apiKeys) ? [] : [model];
    }

    try {
        return providerKeyAvailable(
            providerForModel(model, committeeModels),
            apiKeys,
        )
            ? []
            : [model];
    } catch {
        return [model];
    }
}

export function modelHasApiKey(
    model: string,
    apiKeys?: UserApiKeys,
    committeeModels: CommitteeModel[] = [],
): boolean {
    return (
        missingCommitteeApiKeyModels(model, apiKeys, committeeModels).length ===
        0
    );
}

/**
 * Like resolveModel, but substitutes the first model that has a usable key
 * when the resolved one does not. Returns the original resolution when
 * nothing else is usable, so the provider's own "key not configured" error
 * still surfaces rather than being masked.
 */
export function resolveUsableModel(
    id: string | null | undefined,
    fallback: string,
    apiKeys?: UserApiKeys,
    committeeModels: CommitteeModel[] = [],
): string {
    // A committee the user selected and then deleted must be an explicit
    // error, not a silent downgrade to some other model.
    if (
        id?.startsWith("user-committee/") &&
        !getCommitteeModel(id, committeeModels)
    ) {
        throw new Error(
            `The selected committee (${id}) no longer exists or could not be loaded. Select another model or recreate the committee.`,
        );
    }

    const selected = resolveModel(id, fallback, committeeModels);
    const committee = getCommitteeModel(selected, committeeModels);
    if (committee) {
        const missing = missingCommitteeApiKeyModels(
            selected,
            apiKeys,
            committeeModels,
        );
        if (missing.length) {
            throw new Error(
                `Committee ${committee.label || committee.id} cannot run because these models are unavailable or missing API keys: ${missing.join(", ")}.`,
            );
        }
        return selected;
    }

    if (modelHasApiKey(selected, apiKeys, committeeModels)) return selected;
    for (const candidate of [
        ...configuredModelIds(committeeModels),
        ...ALL_MODELS,
    ]) {
        if (
            candidate !== selected &&
            !getCommitteeModel(candidate, committeeModels) &&
            modelHasApiKey(candidate, apiKeys, committeeModels)
        ) {
            return candidate;
        }
    }
    return selected;
}
