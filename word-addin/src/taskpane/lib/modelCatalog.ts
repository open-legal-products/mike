// Imported from the pure types module (not the API client, whose runtime
// imports include the Sentry SDK) so this module's compile graph stays free
// of Office globals and add-in-only packages: the drift-guard test in
// frontend/src/wordAddin imports this file across packages.
import type { ApiKeyStatus } from "../types";

/**
 * Keep this catalog, its labels, and DEFAULT_MODEL_ID in sync with
 * frontend/src/app/components/assistant/ModelToggle.tsx until both clients use
 * a single shared package.
 */
export type ModelGroup = string;

/** Kept in sync with frontend/src/app/lib/routerModels.ts ROUTER_SLUGS. */
export const ROUTER_SLUGS = [
  "openrouter",
  "vercel",
  "opencode-go",
  "bedrock",
  "azure",
  "azure-foundry",
  "vertex",
  "xai",
  "custom",
] as const;
export type RouterSlug = (typeof ROUTER_SLUGS)[number];

/** Saved model ids per router; a router with none may be absent. */
export type RouterModelSelections = Partial<Record<RouterSlug, string[]>>;

/** The profile field each router's selection is read from. */
export const ROUTER_PROFILE_FIELDS = {
  openrouter: "openRouterModels",
  vercel: "vercelModels",
  "opencode-go": "openCodeGoModels",
  bedrock: "bedrockModels",
  azure: "azureModels",
  "azure-foundry": "azureFoundryModels",
  vertex: "vertexModels",
  xai: "xaiModels",
  custom: "customModels",
} as const satisfies Record<RouterSlug, string>;

export type RouterProfileField = (typeof ROUTER_PROFILE_FIELDS)[RouterSlug];

/** Every router's saved models, read from a profile's per-router fields. */
export function routerModelsFromProfile(
  profile:
    | Partial<Record<RouterProfileField, string[] | null | undefined>>
    | null
    | undefined,
): Record<RouterSlug, string[]> {
  return Object.fromEntries(
    ROUTER_SLUGS.map((slug) => {
      const models = profile?.[ROUTER_PROFILE_FIELDS[slug]];
      return [slug, Array.isArray(models) ? models : []];
    }),
  ) as Record<RouterSlug, string[]>;
}

/** Router names as the web app's settings name them. */
const ROUTER_LABELS: Record<RouterSlug, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  bedrock: "Amazon Bedrock",
  azure: "Azure OpenAI",
  "azure-foundry": "Azure AI Foundry",
  vertex: "Google Vertex AI",
  xai: "xAI",
  custom: "OpenAI-compatible endpoint",
};

export interface ModelOption {
  id: string;
  label: string;
  group: ModelGroup;
  source?: string;
}

export const STATIC_MODELS: readonly ModelOption[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", group: "Anthropic" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Anthropic" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", group: "Google" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)", group: "Google" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", group: "OpenAI" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", group: "OpenAI" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", group: "OpenAI" },
  { id: "mistral-large-4", label: "Mistral Large 4 (Preview)", group: "Mistral AI" },
  { id: "mistral-medium-3-5", label: "Mistral Medium 3.5", group: "Mistral AI" },
  { id: "mistral-small-2603", label: "Mistral Small 4", group: "Mistral AI" },
];

for (const model of STATIC_MODELS) model.source = "Direct";

export const DEFAULT_MODEL_ID = "";
export const ALLOWED_MODEL_IDS = new Set(
  STATIC_MODELS.map((model) => model.id),
);

/**
 * Renamed/retired static ids → their current equivalents. Persisted chat and
 * profile values can outlive a catalog rename, so both clients canonicalize
 * them identically. Kept in sync with backend/src/lib/llm/models.ts and the
 * web ModelToggle; the frontend drift guard pins this mapping.
 */
export const LEGACY_MODEL_IDS: Record<string, string> = {
  "claude-fable-5": "claude-fable-5-1",
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-4-8": "claude-opus-5-5",
  "claude-opus-4-7": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "gemini-3.7-flash": "gemini-3.8-flash",
  "gemini-3.6-flash": "gemini-3.8-flash",
  "gemini-3.5-flash": "gemini-3.8-flash",
  "gemini-3-flash-preview": "gemini-3.8-flash",
  "gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
  "gpt-5.6-sol": "gpt-6-astra",
  "gpt-5.6-terra": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  "gpt-5.5": "gpt-6.1-sol",
  "gpt-5.4": "gpt-6.1-sol",
  "gpt-5.4-mini": "gpt-6-luna",
  "gpt-5.4-lite": "gpt-6-luna",
};

export function canonicalModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] ?? id;
}

const MODEL_NAME_ACRONYMS: Record<string, string> = {
  ai: "AI",
  gpt: "GPT",
  oss: "OSS",
  r1: "R1",
};

export function modelDisplayName(modelId: string): string {
  const normalized = modelId
    .replace(
      /^(?:openrouter|vercel|opencode-go|bedrock|azure-foundry|azure|vertex|xai|custom|ollama)\//,
      "",
    )
    .split("/")
    .at(-1)!
    .replace(/(\d)-(\d)/g, "$1.$2");
  const [rawName, variant] = normalized.split(":", 2);
  const name = rawName ?? normalized;
  const label = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (MODEL_NAME_ACRONYMS[lower]) return MODEL_NAME_ACRONYMS[lower];
      if (/^\d+[bk]$/i.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
  if (!variant) return label;
  const variantLabel = variant
    .split(/[-_]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
  return `${label} (${variantLabel})`;
}

/**
 * The stored selection is the router's raw catalog id (e.g.
 * "anthropic/claude-sonnet-4.5" or "openrouter/auto"); the app-level model id
 * always prefixes the router slug verbatim, with no inner stripping, so both
 * this client and the web app send the identical string for the same stored
 * selection ("openrouter/openrouter/auto" for OpenRouter's "openrouter/auto").
 */
export function openRouterModelOptions(models: string[]): ModelOption[] {
  return optionsForRouter("openrouter", models);
}

export function vercelModelOptions(models: string[]): ModelOption[] {
  return optionsForRouter("vercel", models);
}

export function openCodeGoModelOptions(models: string[]): ModelOption[] {
  return optionsForRouter("opencode-go", models);
}

// Bedrock's cross-region inference-profile prefixes ("us.anthropic.claude-…").
const BEDROCK_GEO_PREFIXES = new Set([
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "ca",
  "global",
]);

/** A Bedrock model id as vendor/model, without AWS-only decoration. */
export function bedrockCatalogModel(modelId: string): string {
  const parts = modelId.split("/").at(-1)!.split(".");
  if (parts.length > 2 && BEDROCK_GEO_PREFIXES.has(parts[0]!)) parts.shift();
  if (parts.length < 2) return modelId;
  const [vendor, ...rest] = parts;
  const name = rest
    .join(".")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/:\d+$/, "")
    .replace(/-\d{8}$/, "");
  return `${vendor}/${name}`;
}

/** Vertex and Foundry ids may state their wire protocol up front. */
export function withoutExplicitProtocol(modelId: string): string {
  return modelId.replace(/^(?:anthropic|openai|gemini):/, "");
}

/** A Vertex AI model id without its version pin or "-maas" suffix. */
export function vertexCatalogModel(modelId: string): string {
  return withoutExplicitProtocol(modelId)
    .replace(/@[^/]*$/, "")
    .replace(/-maas$/, "");
}

// How each router's stored id becomes a label, a maker group and a source
// tag. Mirrors the per-router option builders in the web ModelToggle.tsx.
const ROUTER_OPTION_RULES: Record<
  RouterSlug,
  { source: string; name?: (model: string) => string; group?: string }
> = {
  openrouter: { source: "OpenRouter" },
  vercel: { source: "Vercel" },
  "opencode-go": { source: "OpenCode" },
  bedrock: { source: "Bedrock", name: bedrockCatalogModel },
  azure: { source: "Azure" },
  "azure-foundry": { source: "Foundry", name: withoutExplicitProtocol },
  vertex: { source: "Vertex", name: vertexCatalogModel },
  xai: { source: "xAI", group: "xAI" },
  custom: { source: "Custom" },
};

function optionsForRouter(router: RouterSlug, models: string[]): ModelOption[] {
  const rule = ROUTER_OPTION_RULES[router];
  return models.map((model) => {
    const name = rule.name ? rule.name(model) : model;
    return {
      id: `${router}/${model}`,
      label: modelDisplayName(name),
      group: rule.group ?? underlyingProviderGroup(name, router),
      source: rule.source,
    };
  });
}

/** Picker options for every saved router model, in router order. */
export function routerModelOptions(
  selections: RouterModelSelections,
): ModelOption[] {
  return ROUTER_SLUGS.flatMap((slug) =>
    optionsForRouter(slug, selections[slug] ?? []),
  );
}

const ROUTER_VENDOR_GROUPS: Record<string, string> = {
  anthropic: "Anthropic",
  claude: "Anthropic",
  google: "Google",
  gemini: "Google",
  openai: "OpenAI",
  gpt: "OpenAI",
  moonshot: "Moonshot AI",
  moonshotai: "Moonshot AI",
  kimi: "Moonshot AI",
  zhipu: "Zhipu AI",
  zhipuai: "Zhipu AI",
  zai: "Zhipu AI",
  minimax: "MiniMax",
  qwen: "Alibaba",
  alibaba: "Alibaba",
  deepseek: "DeepSeek",
  xiaomi: "Xiaomi",
  mimo: "Xiaomi",
  mistral: "Mistral AI",
  mistralai: "Mistral AI",
  meta: "Meta",
  amazon: "Amazon",
  xai: "xAI",
  grok: "xAI",
};

export function underlyingProviderGroup(
  catalogModelId: string,
  router: RouterSlug,
): string {
  const vendor = catalogModelId.includes("/")
    ? catalogModelId.split("/", 1)[0]!.toLowerCase()
    : catalogModelId.toLowerCase().split(/[-_.]/, 1)[0]!;
  const mapped = ROUTER_VENDOR_GROUPS[vendor];
  if (mapped) return mapped;
  if (catalogModelId.includes("/")) {
    return vendor
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  if (router === "opencode-go") {
    if (/^glm-/i.test(catalogModelId)) return "Zhipu AI";
    if (/^kimi-/i.test(catalogModelId)) return "Moonshot AI";
    if (/^minimax-/i.test(catalogModelId)) return "MiniMax";
    if (/^qwen/i.test(catalogModelId)) return "Alibaba";
    if (/^deepseek-/i.test(catalogModelId)) return "DeepSeek";
    if (/^mimo-/i.test(catalogModelId)) return "Xiaomi";
  }
  return "Other providers";
}

/** The router a namespaced model id routes through, if any. */
export function routerForModelId(modelId: string): RouterSlug | null {
  return ROUTER_SLUGS.find((slug) => modelId.startsWith(`${slug}/`)) ?? null;
}

export function isAllowedModelId(id: string): boolean {
  return (
    ALLOWED_MODEL_IDS.has(id) ||
    id.startsWith("ollama/") ||
    ROUTER_SLUGS.some((slug) => id.startsWith(`${slug}/`))
  );
}

export function isModelAvailable(
  modelId: string,
  status: ApiKeyStatus | null,
): boolean {
  if (modelId.startsWith("ollama/")) return true;
  // Unknown status (the key-status preflight failed even after a retry) fails
  // OPEN: the backend authoritatively rejects a model it cannot serve, so
  // blocking sends here on a flaky WKWebView request would brick the composer
  // for requests the backend would happily accept.
  if (!status) return true;
  const router = routerForModelId(modelId);
  if (router) return !!status[router];
  const model = STATIC_MODELS.find((item) => item.id === canonicalModelId(modelId));
  if (!model || model.group === "Local") return false;
  if (model.group === "Anthropic") return !!status.claude;
  if (model.group === "Google") return !!status.gemini;
  if (model.group === "Mistral AI") return !!status.mistral;
  return !!status.openai;
}

export function missingModelProvider(modelId: string): string {
  const group = STATIC_MODELS.find((item) => item.id === canonicalModelId(modelId))?.group;
  const router = routerForModelId(modelId);
  if (router) return ROUTER_LABELS[router];
  if (group === "Mistral AI") return "Mistral AI";
  return group === "Anthropic"
    ? "Anthropic"
    : group === "Google"
      ? "Google"
      : group === "OpenAI"
        ? "OpenAI"
        : "model provider";
}
