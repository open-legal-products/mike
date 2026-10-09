import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import {
  azureClientTarget,
  azureCredentials,
  azureFoundryCredentials,
  bedrockCredentials,
  customEndpointCredentials,
  vertexCredentials,
} from "./cloudProviders";
import { guardedFetch } from "../mcp/client";
import { localModelToleranceMiddleware } from "./localModelMiddleware";
import {
  azureDeploymentName,
  azureFoundryDeploymentName,
  bedrockModelId,
  customEndpointModelId,
  isAzureFoundryClaudeDeployment,
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  normalizeReasoningLevelForModel,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
  vertexModelId,
  vertexModelProtocol,
  xaiModelId,
} from "./models";
import {
  apiKeyForConfiguredModel,
  getConfiguredModel,
  tolerateTextToolCalls,
} from "./registry";
import type {
  ConfiguredModel,
  Provider,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { REASONING_LEVELS } from "./types";
import { vertexAuthClient } from "./vertexAuth";
import { UserFacingError } from "../userFacingError";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://openrouter.ai/api/v1";
const OPENCODE_GO_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://opencode.ai/zen/go/v1";
const VERCEL_GATEWAY_BASE_URL =
  process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");

type CompleteProviderParams = {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
};

type RouterProvider = Extract<
  Provider,
  "openrouter" | "vercel" | "opencode-go"
>;

const ROUTER_LABELS: Record<RouterProvider, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
};

const ROUTER_KEY_ENV_HINTS: Record<RouterProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

// Env aliases a provider also answers to. CLAUDE_API_KEY is accepted by
// envApiKey("claude") in modules/user/user.apiKeyStore.ts, which decides
// whether Settings reports the key as configured — without the same alias here
// a deployment that only sets CLAUDE_API_KEY showed a green key and then
// failed every request with "not configured".
const ENVIRONMENT_KEY_ALIASES: Record<string, string[]> = {
  ANTHROPIC_API_KEY: ["CLAUDE_API_KEY"],
};

function requiredKey(
  label: string,
  environmentVariable: string,
  override?: string | null,
): string {
  const key =
    override?.trim() ||
    process.env[environmentVariable]?.trim() ||
    (ENVIRONMENT_KEY_ALIASES[environmentVariable] ?? [])
      .map((alias) => process.env[alias]?.trim())
      .find((value) => !!value) ||
    "";
  if (!key) {
    throw new Error(
      `${label} API key is not configured. Set ${environmentVariable} or add a user ${label} key.`,
    );
  }
  return key;
}

function routerEnvironmentKey(provider: RouterProvider): string | undefined {
  if (provider === "vercel") {
    return (
      process.env.AI_GATEWAY_API_KEY?.trim() ||
      process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
    );
  }
  if (provider === "opencode-go") return process.env.OPENCODE_API_KEY?.trim();
  return process.env.OPENROUTER_API_KEY?.trim();
}

function routerUserKey(
  provider: RouterProvider,
  apiKeys?: UserApiKeys,
): string | null | undefined {
  if (provider === "vercel") return apiKeys?.vercel;
  if (provider === "opencode-go") return apiKeys?.["opencode-go"];
  return apiKeys?.openrouter;
}

function routerKey(provider: RouterProvider, apiKeys?: UserApiKeys): string {
  const key =
    routerUserKey(provider, apiKeys)?.trim() || routerEnvironmentKey(provider);
  if (!key) {
    throw new Error(
      `${ROUTER_LABELS[provider]} API key is not configured. Set ${ROUTER_KEY_ENV_HINTS[provider]} or add a user ${ROUTER_LABELS[provider]} key.`,
    );
  }
  return key;
}

async function createAnthropicAdapter(args: {
  provider: Extract<Provider, "claude" | "opencode-go" | "azure-foundry">;
  label: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  supportsReasoning: boolean;
}): Promise<AiSdkAdapterConfig> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    name: `${args.provider}.messages`,
    fetch: aiSdkFetch,
  });
  return {
    provider: args.provider,
    label: args.label,
    model: anthropic(args.model),
    modelId: args.model,
    supportsReasoning: args.supportsReasoning,
  };
}

async function createRouterAdapter(
  provider: RouterProvider,
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  if (provider === "opencode-go" && !isOpenCodeGoChatCompletionsModel(model)) {
    throw unsupportedOpenCodeGoModel(model);
  }
  const key = routerKey(provider, apiKeys);

  if (provider === "openrouter") {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({
      apiKey: key,
      baseURL: OPENROUTER_BASE_URL,
      compatibility: "strict",
      appName: "Mike",
      appUrl: process.env.FRONTEND_URL,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: openrouter.chat(openRouterModelId(model)),
      modelId: model,
    };
  }

  if (provider === "vercel") {
    const { createGateway } = await import("ai");
    const gateway = createGateway({
      apiKey: key,
      ...(VERCEL_GATEWAY_BASE_URL ? { baseURL: VERCEL_GATEWAY_BASE_URL } : {}),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: gateway.chat(vercelModelId(model)),
      modelId: model,
    };
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const openCodeGo = createOpenAICompatible({
    name: "opencodeGo",
    apiKey: key,
    baseURL: OPENCODE_GO_BASE_URL,
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: ROUTER_LABELS[provider],
    model: openCodeGo(openCodeGoModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

/**
 * Bedrock's prompt caching takes an explicit cache point, which most Bedrock
 * models reject, so it is only sent to Claude. Claude ids appear bare
 * ("anthropic.claude-…"), behind a cross-region profile prefix
 * ("us.anthropic.claude-…") or inside an inference-profile ARN.
 */
export function bedrockModelSupportsCachePoint(modelId: string): boolean {
  return /(?:^|[./])anthropic\.claude-/.test(modelId);
}

async function createBedrockAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = bedrockCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Amazon Bedrock API key is not configured. Set AWS_BEARER_TOKEN_BEDROCK and BEDROCK_AWS_REGION or add a user Amazon Bedrock key and region.",
    );
  }
  const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
  // An explicit apiKey makes the SDK use bearer auth and never fall back to
  // ambient AWS credentials (which a deployment may hold for S3 storage).
  const bedrock = createAmazonBedrock({
    apiKey: credentials.apiKey,
    region: credentials.region,
    fetch: aiSdkFetch,
  });
  const upstreamId = bedrockModelId(model);
  return {
    provider: "bedrock",
    label: "Amazon Bedrock",
    model: bedrock(upstreamId),
    modelId: model,
    bedrockCachePoint: bedrockModelSupportsCachePoint(upstreamId),
  };
}

async function createAzureAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = azureCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Azure OpenAI API key is not configured. Set AZURE_API_KEY and AZURE_OPENAI_ENDPOINT or add a user Azure OpenAI key and endpoint.",
    );
  }
  const { createAzure } = await import("@ai-sdk/azure");
  const azure = createAzure({
    apiKey: credentials.apiKey,
    ...azureClientTarget(credentials.endpoint),
    fetch: aiSdkFetch,
  });
  return {
    provider: "azure",
    label: "Azure OpenAI",
    // The deployment name doubles as the model id the SDK uses to infer
    // reasoning support, so deployments named after their model ("gpt-6.1-sol")
    // get reasoning controls and arbitrary names run without them.
    model: azure.responses(azureDeploymentName(model)),
    modelId: model,
    courtlistenerCitationReminder: true,
  };
}

async function createAzureFoundryAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = azureFoundryCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Azure AI Foundry API key is not configured. Set AZURE_FOUNDRY_API_KEY and AZURE_FOUNDRY_ENDPOINT or add a user Azure AI Foundry key and endpoint.",
    );
  }
  const deployment = azureFoundryDeploymentName(model);
  if (isAzureFoundryClaudeDeployment(model)) {
    return createAnthropicAdapter({
      provider: "azure-foundry",
      label: "Azure AI Foundry",
      model: deployment,
      apiKey: credentials.apiKey,
      baseURL: `${credentials.endpoint}/anthropic/v1`,
      supportsReasoning: true,
    });
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const foundry = createOpenAICompatible({
    name: "azureFoundry",
    apiKey: credentials.apiKey,
    // The v1 endpoint takes the key as a bearer token or as Azure's own
    // header; sending both covers resources that only accept one.
    headers: { "api-key": credentials.apiKey },
    baseURL: `${credentials.endpoint}/openai/v1`,
    fetch: aiSdkFetch,
  });
  return {
    provider: "azure-foundry",
    label: "Azure AI Foundry",
    model: foundry(deployment),
    modelId: model,
    supportsReasoning: false,
  };
}

async function createVertexAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = vertexCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Google Vertex AI credentials are not configured. Set GOOGLE_VERTEX_CREDENTIALS_JSON and GOOGLE_VERTEX_LOCATION or add a user Vertex AI service-account key and location.",
    );
  }
  // A ready-made auth client keeps google-auth-library from ever looking for
  // ambient credentials (a deployment may hold its own for storage).
  const settings = {
    project: credentials.project,
    location: credentials.location,
    googleAuthOptions: { authClient: await vertexAuthClient(credentials) },
    fetch: aiSdkFetch,
  };
  const upstreamId = vertexModelId(model);
  const base = { provider: "vertex" as const, label: "Google Vertex AI", modelId: model };
  const protocol = vertexModelProtocol(model);
  if (protocol === "anthropic") {
    const { createVertexAnthropic } = await import(
      "@ai-sdk/google-vertex/anthropic"
    );
    return { ...base, model: createVertexAnthropic(settings)(upstreamId) };
  }
  if (protocol === "maas") {
    const { createVertexMaas } = await import("@ai-sdk/google-vertex/maas");
    return {
      ...base,
      model: createVertexMaas(settings)(upstreamId),
      supportsReasoning: false,
    };
  }
  const { createVertex } = await import("@ai-sdk/google-vertex");
  // An explicit empty apiKey stops the SDK from switching to express mode on
  // a GOOGLE_VERTEX_API_KEY in the environment, which would bypass the
  // service account chosen above.
  const vertex = createVertex({ ...settings, apiKey: "" });
  return { ...base, model: vertex(upstreamId) };
}

/**
 * Egress for a user-supplied base URL: https only, never a private or
 * metadata address, pinned to the address that was validated.
 */
async function customEndpointFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return aiSdkFetch(input, init, guardedFetch);
}

async function createCustomEndpointAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = customEndpointCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "OpenAI-compatible endpoint is not configured. Add an API key and base URL in Settings → Bring Your Own Keys.",
    );
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const client = createOpenAICompatible({
    name: "custom",
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    fetch: customEndpointFetch,
  });
  return {
    provider: "custom",
    label: "OpenAI-compatible endpoint",
    model: client(customEndpointModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

function configuredModelOrThrow(id: string): ConfiguredModel {
  const configured = getConfiguredModel(id);
  if (!configured) {
    throw new Error(
      `Model ${id} is not declared in MIKE_MODEL_CONFIG_JSON.`,
    );
  }
  if (!configured.baseUrl?.trim()) {
    throw new Error(`Configured model ${id} is missing a baseUrl.`);
  }
  return configured;
}

async function createConfiguredAdapter(
  id: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const configured = configuredModelOrThrow(id);
  if (configured.apiKeyProvider && apiKeys?.disabledProviders?.includes(configured.apiKeyProvider)) {
    throw new UserFacingError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const apiKey = apiKeyForConfiguredModel(configured, apiKeys);
  const client = createOpenAICompatible({
    name: configured.id,
    baseURL: configured.baseUrl,
    // Omit Authorization entirely for endpoints declared without auth.
    ...(apiKey ? { apiKey } : {}),
    ...(configured.maxTokensField === "max_completion_tokens"
      ? {
          transformRequestBody: (body: Record<string, unknown>) => {
            const { max_tokens: maxTokens, ...rest } = body;
            return maxTokens === undefined
              ? rest
              : { ...rest, max_completion_tokens: maxTokens };
          },
        }
      : {}),
    fetch: aiSdkFetch,
  });
  const base = client(configured.apiModel ?? configured.id);
  const { wrapLanguageModel } = await import("ai");
  return {
    provider: "openai-compatible",
    label: configured.label || configured.id,
    model: tolerateTextToolCalls(configured)
      ? wrapLanguageModel({
          model: base,
          middleware: localModelToleranceMiddleware(),
        })
      : base,
    modelId: configured.id,
    supportsReasoning: false,
  };
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed under OpenCode Go in Settings → Bring Your Own Keys.`,
  );
}

function ollamaBaseUrl(): string {
  return (
    process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
  ).replace(/\/$/, "");
}

function ollamaModelName(model: string): string {
  const tag = model.replace(/^ollama\/?/, "");
  return tag || process.env.OLLAMA_MODEL?.trim() || "qwen3.6";
}

export function ollamaAuthHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function createProviderAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const provider = providerForModel(model);
  if (apiKeys?.disabledProviders?.includes(provider)) {
    throw new UserFacingError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
  }

  if (provider === "claude") {
    return createAnthropicAdapter({
      provider,
      label: "Claude",
      model,
      apiKey: requiredKey("Anthropic", "ANTHROPIC_API_KEY", apiKeys?.claude),
      supportsReasoning: true,
    });
  }

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: requiredKey("Gemini", "GEMINI_API_KEY", apiKeys?.gemini),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Gemini", model: google(model), modelId: model };
  }

  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: requiredKey("OpenAI", "OPENAI_API_KEY", apiKeys?.openai),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "OpenAI",
      model: openai.responses(model),
      modelId: model,
      courtlistenerCitationReminder: true,
    };
  }

  if (provider === "mistral") {
    const { createMistral } = await import("@ai-sdk/mistral");
    const mistral = createMistral({
      apiKey: requiredKey("Mistral", "MISTRAL_API_KEY", apiKeys?.mistral),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Mistral", model: mistral(model), modelId: model };
  }

  if (provider === "openrouter" || provider === "vercel") {
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "opencode-go") {
    if (isOpenCodeGoMessagesModel(model)) {
      return createAnthropicAdapter({
        provider,
        label: "OpenCode Go",
        model: openCodeGoModelId(model),
        apiKey: routerKey(provider, apiKeys),
        baseURL: OPENCODE_GO_BASE_URL,
        supportsReasoning: false,
      });
    }
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "bedrock") return createBedrockAdapter(model, apiKeys);
  if (provider === "azure") return createAzureAdapter(model, apiKeys);
  if (provider === "azure-foundry") {
    return createAzureFoundryAdapter(model, apiKeys);
  }
  if (provider === "vertex") return createVertexAdapter(model, apiKeys);
  if (provider === "custom") return createCustomEndpointAdapter(model, apiKeys);

  if (provider === "xai") {
    const { createXai } = await import("@ai-sdk/xai");
    const xai = createXai({
      apiKey: requiredKey("xAI", "XAI_API_KEY", apiKeys?.xai),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "xAI",
      model: xai(xaiModelId(model)),
      modelId: model,
    };
  }

  if (provider === "openai-compatible") {
    return createConfiguredAdapter(model, apiKeys);
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: ollamaBaseUrl(),
    headers: ollamaAuthHeaders(),
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: "Ollama",
    model: ollama(ollamaModelName(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const normalizedParams = {
    ...params,
    reasoning: normalizeReasoningLevelForModel(
      params.model,
      params.reasoning ?? "none",
    ),
  };
  try {
    return await streamAiSdk(
      normalizedParams,
      await createProviderAdapter(params.model, params.apiKeys),
    );
  } catch (error) {
    const retryReasoning = fallbackReasoningLevelFromProviderError(
      error,
      normalizedParams.reasoning,
    );
    if (retryReasoning) {
      return streamAiSdk(
        { ...normalizedParams, reasoning: retryReasoning },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    if (
      providerForModel(params.model) === "ollama" &&
      params.tools?.length &&
      !params.requireTools &&
      /does not support tools/i.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      return streamAiSdk(
        { ...normalizedParams, tools: undefined, runTools: undefined },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    throw error;
  }
}

/**
 * Provider model capabilities can change ahead of the SDK's shared types.
 * Retry request-validation failures at the nearest level advertised by the
 * provider, before any stream content has been emitted.
 */
export function fallbackReasoningLevelFromProviderError(
  error: unknown,
  requested: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  if (!requested) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const marker = "supported values are:";
  const markerIndex = message.toLocaleLowerCase().indexOf(marker);
  if (markerIndex < 0) return undefined;
  const supportedText = message.slice(markerIndex + marker.length).trimStart();
  if (!supportedText) return undefined;

  const supported = [...supportedText.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter(
      (level): level is ReasoningLevel =>
        !!level && (REASONING_LEVELS as readonly string[]).includes(level),
    );
  if (!supported.length || supported.includes(requested)) return undefined;

  const requestedIndex = REASONING_LEVELS.indexOf(requested);
  return supported.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(
      REASONING_LEVELS.indexOf(nearest) - requestedIndex,
    );
    const candidateDistance = Math.abs(
      REASONING_LEVELS.indexOf(candidate) - requestedIndex,
    );
    return candidateDistance <= nearestDistance ? candidate : nearest;
  });
}

export async function completeWithProvider(
  params: CompleteProviderParams,
): Promise<string> {
  return completeAiSdkText(
    params,
    await createProviderAdapter(params.model, params.apiKeys),
  );
}
