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
      ? record.models.filter(isConfiguredModel)
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

/**
 * Local endpoints are the ones that routinely emit tool calls as prose, so
 * they get the tolerant parsing path unless the config says otherwise.
 */
export function tolerateTextToolCalls(model: ConfiguredModel): boolean {
  return model.tolerateTextToolCalls ?? model.location === "local";
}

// Only OpenAI-compatible endpoints are declarable. The hosted providers are
// covered by the static catalog in models.ts and by the router prefixes
// (openrouter/, vercel/, opencode-go/), so a configured entry for one of them
// would be a second, subtly different way to say the same thing.
function isConfiguredModel(value: unknown): value is ConfiguredModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    record.provider === "openai-compatible" &&
    (record.location === "cloud" || record.location === "local")
  );
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
