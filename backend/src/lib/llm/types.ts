// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider =
    | "claude"
    | "gemini"
    | "openai"
    | "mistral"
    | "openai-compatible"
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

export const REASONING_LEVELS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    /** Meaningful provider output, even when the consumer buffers it. */
    onActivity?: () => void;
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    /** Explicitly disabled providers must never fall back to deployment keys. */
    disabledProviders?: readonly string[];
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
    mistral?: string | null;
    openrouter?: string | null;
    vercel?: string | null;
    "opencode-go"?: string | null;
    bedrock?: string | null;
    azure?: string | null;
    "azure-foundry"?: string | null;
    /** A Google Cloud service-account key (the JSON file's contents). */
    vertex?: string | null;
    xai?: string | null;
    /** The key for the user's own OpenAI-compatible endpoint. */
    custom?: string | null;
    courtlistener?: string | null;
    /**
     * Non-secret settings that only make sense together with the key above
     * them: the AWS region a Bedrock key belongs to, the Azure resource an
     * Azure key belongs to, the Vertex AI location a service account is used
     * in, the base URL of a custom endpoint. Each entry comes from the same
     * source (the user's saved key or the deployment's environment) as its
     * key, so a user's key is never sent to the operator's endpoint.
     */
    providerSettings?: ProviderSettings;
};

export type ProviderSettings = {
    bedrock?: { region: string } | null;
    azure?: { endpoint: string } | null;
    "azure-foundry"?: { endpoint: string } | null;
    vertex?: { location: string } | null;
    custom?: { baseUrl: string } | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Require the selected provider to preserve tool calling. Curator jobs set
     * this so a provider capability error is retryable instead of silently
     * degrading into a tool-less response that looks like "no change".
     */
    requireTools?: boolean;
    /**
     * AI SDK reasoning effort. Bulk extraction jobs should leave this unset;
     * the SDK adapter maps an omitted level to "none" to save tokens and
     * latency.
     */
    reasoning?: ReasoningLevel;
    abortSignal?: AbortSignal;
    /**
     * Durable id of the conversation this request belongs to. Adapters use it
     * to keep provider prefix caches warm across turns (an OpenAI
     * prompt_cache_key, an Anthropic cache breakpoint). Leave unset for
     * one-shot calls such as the memory curator.
     */
    conversationId?: string | null;
};

export type StreamChatResult = {
    fullText: string;
};

// ---------------------------------------------------------------------------
// Configured models
// ---------------------------------------------------------------------------
// The static catalog in models.ts covers the hosted providers Mike ships with.
// Deployments that also run self-hosted or third-party OpenAI-compatible
// endpoints declare them through MIKE_MODEL_CONFIG_JSON; see registry.ts.

export type ModelLocation = "cloud" | "local";

export type ConfiguredModel = {
    id: string;
    provider: "openai-compatible";
    location: ModelLocation;
    label?: string;
    /** Model name to send upstream when it differs from the Mike-facing id. */
    apiModel?: string;
    baseUrl: string;
    apiKeyEnv?: string;
    apiKeyProvider?: keyof UserApiKeys;
    apiKey?: string;
    /**
     * Local models frequently emit tool calls as prose rather than as
     * structured tool-call fields. Leave unset to infer from `location`.
     */
    tolerateTextToolCalls?: boolean;
    /** Request field used for the output-token limit by the compatible endpoint. */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
};

/**
 * A committee answers one prompt with several models and has a chair model
 * synthesize their replies into the single response the caller sees.
 */
export type CommitteeModel = {
    id: string;
    label?: string;
    members: Array<
        | string
        | {
              id?: string;
              model: string;
              label?: string;
              systemPrompt?: string;
          }
    >;
    chair: string;
    strategy?: "synthesize";
};
