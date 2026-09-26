import type {
  CommitteeModel,
  ConfiguredModel,
  Provider,
  UserApiKeys,
} from "./types";

// Deployment-declared models. The static catalog in models.ts covers the
// hosted providers Mike ships with; this registry is how an operator adds a
// self-hosted or third-party endpoint (and, in a later change, committees)
// without a code change. Everything is read from one env var so the
// configuration travels with the deployment rather than the database.

type ModelRegistryConfig = {
  models: ConfiguredModel[];
  committees: CommitteeModel[];
};

const EMPTY_CONFIG: ModelRegistryConfig = { models: [], committees: [] };

let cached: ModelRegistryConfig | undefined;

export function loadModelRegistry(): ModelRegistryConfig {
  if (cached) return cached;

  const raw = process.env.MIKE_MODEL_CONFIG_JSON?.trim();
  if (!raw) {
    cached = EMPTY_CONFIG;
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MIKE_MODEL_CONFIG_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  cached = {
    models: Array.isArray(record.models)
      ? record.models.flatMap((value) => {
          const model = parseConfiguredModel(value);
          return model ? [model] : [];
        })
      : [],
    committees: Array.isArray(record.committees)
      ? record.committees.filter(isCommitteeModel)
      : [],
  };
  return cached;
}

/** Test seam — the registry is otherwise parsed once per process. */
export function resetModelRegistryCache(): void {
  cached = undefined;
}

export function getConfiguredModel(id: string): ConfiguredModel | null {
  return loadModelRegistry().models.find((model) => model.id === id) ?? null;
}

export function getCommitteeModel(
  id: string,
  additionalCommittees: CommitteeModel[] = [],
): CommitteeModel | null {
  return (
    additionalCommittees.find((committee) => committee.id === id) ??
    loadModelRegistry().committees.find((committee) => committee.id === id) ??
    null
  );
}

export function configuredModelIds(
  additionalCommittees: CommitteeModel[] = [],
): string[] {
  return configuredModelSummaries(additionalCommittees).map(
    (summary) => summary.id,
  );
}

export type ConfiguredModelSummary = {
  id: string;
  label: string;
  provider: Provider | "committee";
  location: ModelSummaryLocation;
};

type ModelSummaryLocation = ConfiguredModel["location"] | "committee";

export function configuredModelSummaries(
  additionalCommittees: CommitteeModel[] = [],
): ConfiguredModelSummary[] {
  const registry = loadModelRegistry();
  const committees = [...registry.committees, ...additionalCommittees];
  return [
    ...registry.models.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      provider: model.provider,
      location: model.location,
    })),
    ...committees.map((committee) => ({
      id: committee.id,
      label: committee.label || committee.id,
      provider: "committee" as const,
      location: "committee" as const,
    })),
  ];
}

export function apiKeyForConfiguredModel(
  model: ConfiguredModel,
  apiKeys?: UserApiKeys,
): string | null {
  if (model.apiKey?.trim()) return model.apiKey.trim();
  if (model.apiKeyProvider) {
    const userKey = apiKeys?.[model.apiKeyProvider];
    if (typeof userKey === "string" && userKey.trim()) return userKey.trim();
  }
  if (model.apiKeyEnv?.trim()) {
    return process.env[model.apiKeyEnv.trim()]?.trim() || null;
  }
  return null;
}

/** Whether the declaration names an authentication source that must resolve. */
export function configuredModelRequiresApiKey(model: ConfiguredModel): boolean {
  return Boolean(model.apiKey || model.apiKeyEnv || model.apiKeyProvider);
}

export type ConfiguredEndpointSummary = {
  id: string;
  label: string;
  location: ConfiguredModel["location"];
  available: boolean;
};

/** Public, secret-free catalog information for the requesting user. */
export function configuredEndpointSummaries(
  apiKeys?: UserApiKeys,
): ConfiguredEndpointSummary[] {
  return loadModelRegistry().models.map((model) => ({
    id: model.id,
    label: model.label || model.id,
    location: model.location,
    available:
      !configuredModelRequiresApiKey(model) ||
      apiKeyForConfiguredModel(model, apiKeys) !== null,
  }));
}

/**
 * Local endpoints are the ones that routinely emit tool calls as prose, so
 * they get the tolerant parsing path unless the config says otherwise.
 */
export function tolerateTextToolCalls(model: ConfiguredModel): boolean {
  return model.tolerateTextToolCalls ?? model.location === "local";
}

/**
 * Whether history sent to this model should carry each earlier assistant
 * turn's stored reasoning. Only configured models can opt in; see
 * `ConfiguredModel.replayReasoning`.
 */
export function replaysReasoning(id: string): boolean {
  return getConfiguredModel(id)?.replayReasoning === true;
}

// Only OpenAI-compatible endpoints are declarable. The hosted providers are
// covered by the static catalog in models.ts and by the router prefixes
// (openrouter/, vercel/, opencode-go/), so a configured entry for one of them
// would be a second, subtly different way to say the same thing.
const USER_API_KEY_PROVIDERS = new Set<keyof UserApiKeys>([
  "claude",
  "gemini",
  "openai",
  "openrouter",
  "vercel",
  "opencode-go",
  "courtlistener",
]);

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function validBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function parseConfiguredModel(value: unknown): ConfiguredModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = optionalString(record, "id");
  const label = optionalString(record, "label");
  const apiModel = optionalString(record, "apiModel");
  const baseUrl = optionalString(record, "baseUrl");
  const apiKeyEnv = optionalString(record, "apiKeyEnv");
  const apiKey = optionalString(record, "apiKey");
  const apiKeyProvider = record.apiKeyProvider;
  const maxTokensField = record.maxTokensField;

  if (
    !id ||
    id.length > 200 ||
    /\s/.test(id) ||
    record.provider !== "openai-compatible" ||
    (record.location !== "cloud" && record.location !== "local") ||
    !baseUrl ||
    !validBaseUrl(baseUrl) ||
    label === null ||
    apiModel === null ||
    apiKeyEnv === null ||
    apiKey === null ||
    (apiKeyProvider !== undefined &&
      (typeof apiKeyProvider !== "string" ||
        !USER_API_KEY_PROVIDERS.has(apiKeyProvider as keyof UserApiKeys))) ||
    (record.tolerateTextToolCalls !== undefined &&
      typeof record.tolerateTextToolCalls !== "boolean") ||
    (record.replayReasoning !== undefined &&
      typeof record.replayReasoning !== "boolean") ||
    (maxTokensField !== undefined &&
      maxTokensField !== "max_tokens" &&
      maxTokensField !== "max_completion_tokens")
  ) {
    return null;
  }

  return {
    id,
    provider: "openai-compatible",
    location: record.location,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(label ? { label } : {}),
    ...(apiModel ? { apiModel } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyProvider
      ? { apiKeyProvider: apiKeyProvider as keyof UserApiKeys }
      : {}),
    ...(typeof record.tolerateTextToolCalls === "boolean"
      ? { tolerateTextToolCalls: record.tolerateTextToolCalls }
      : {}),
    ...(maxTokensField ? { maxTokensField } : {}),
    ...(record.replayReasoning === true ? { replayReasoning: true } : {}),
  };
}

function isCommitteeModel(value: unknown): value is CommitteeModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.chair === "string" &&
    Array.isArray(record.members) &&
    record.members.every(
      (member) =>
        typeof member === "string" ||
        (!!member &&
          typeof member === "object" &&
          typeof (member as Record<string, unknown>).model === "string"),
    )
  );
}
