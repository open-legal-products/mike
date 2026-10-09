// The model catalog both clients build their pickers from: the web app (via
// "@/shared/lib/modelCatalog") and the Word add-in (via the
// "@mike/model-catalog" alias in word-addin/tsconfig.json and
// webpack.config.js). Pure data and functions only: nothing here may import
// from frontend/src/app or reach a framework, so the add-in can compile it.
//
// It owns:
// - the static catalog, legacy-id mapping and display names;
// - router slugs (which double as model-id prefixes and API-key provider
//   names), each router's saved Model Selections and the picker rows built
//   from them;
// - key-based availability, and the messages for an empty picker or an
//   unavailable model.

import type { ModelToggleOption } from "../ui/ModelToggleUI";

export type ModelOption = ModelToggleOption;

// ---------------------------------------------------------------------------
// Static catalog
// ---------------------------------------------------------------------------

const direct = (option: Omit<ModelOption, "source">): ModelOption => ({
  ...option,
  source: "Direct",
});

/** The direct-provider models every picker offers. */
export const MODELS: readonly ModelOption[] = [
  direct({ id: "claude-fable-5-1", label: "Claude Fable 5.1", group: "Anthropic" }),
  direct({ id: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Anthropic" }),
  direct({ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Anthropic" }),
  direct({ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", group: "Google" }),
  direct({ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)", group: "Google" }),
  direct({ id: "gpt-6-astra", label: "GPT-6 Astra", group: "OpenAI" }),
  direct({ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", group: "OpenAI" }),
  direct({ id: "gpt-6-luna", label: "GPT-6 Luna", group: "OpenAI" }),
  direct({ id: "mistral-large-4", label: "Mistral Large 4 (Preview)", group: "Mistral AI" }),
  direct({ id: "mistral-medium-3-5", label: "Mistral Medium 3.5", group: "Mistral AI" }),
  direct({ id: "mistral-small-2603", label: "Mistral Small 4", group: "Mistral AI" }),
];

/** MODELS plus the low-cost models offered only for background tasks. */
export const SETTINGS_MODELS: readonly ModelOption[] = [
  ...MODELS,
  direct({ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" }),
  direct({ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", group: "Google" }),
];

export const DEFAULT_MODEL_ID = "";

export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(
  MODELS.map((model) => model.id),
);

/**
 * Renamed/retired static ids → their current equivalents. Stored preferences
 * (profile fields, chat settings, local selections) outlive catalog renames;
 * mapping them on read keeps an old saved value working instead of orphaning
 * it. Kept in sync with backend/src/lib/llm/models.ts LEGACY_MODEL_IDS
 * (frontend/src/wordAddin/catalogParity.test.ts pins the two).
 */
export const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
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

// ---------------------------------------------------------------------------
// Routers and their Model Selections
// ---------------------------------------------------------------------------

/**
 * Router slugs, which double as model-id prefixes and API-key provider names.
 * Kept in sync with backend/src/lib/routerModels.ts ROUTER_SLUGS.
 */
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

export function isRouterSlug(value: string): value is RouterSlug {
  return (ROUTER_SLUGS as readonly string[]).includes(value);
}

/** The profile field (GET/PATCH /user/profile) holding each router's Model Selections. */
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
export type RouterProfileField =
  (typeof ROUTER_PROFILE_FIELDS)[RouterSlug];

/** Every router's saved Model Selections, as profile fields. */
export type RouterProfileLists = Record<RouterProfileField, string[]>;

/** Every router's saved Model Selections, keyed by router slug. */
export type RouterSelections = Record<RouterSlug, string[]>;

/**
 * Each router's saved Model Selections from a profile, keyed by slug. A
 * missing or malformed list (an older API, a partial response) is empty.
 */
export function routerSelections(
  profile: Partial<Record<RouterProfileField, unknown>>,
): RouterSelections {
  return Object.fromEntries(
    ROUTER_SLUGS.map((slug) => {
      const models = profile[ROUTER_PROFILE_FIELDS[slug]];
      return [slug, Array.isArray(models) ? (models as string[]) : []];
    }),
  ) as RouterSelections;
}

/** The same lists, back under their profile field names. */
export function routerProfileLists(
  profile: Partial<Record<RouterProfileField, unknown>>,
): RouterProfileLists {
  const selections = routerSelections(profile);
  return Object.fromEntries(
    ROUTER_SLUGS.map((slug) => [ROUTER_PROFILE_FIELDS[slug], selections[slug]]),
  ) as RouterProfileLists;
}

/** The router an app-level model id routes through, if any. */
export function routerForModelId(modelId: string): RouterSlug | null {
  // "azure-foundry/" does not start with "azure/": the trailing slash keeps
  // the slugs from shadowing each other.
  return ROUTER_SLUGS.find((slug) => modelId.startsWith(`${slug}/`)) ?? null;
}

/**
 * Whether a router model id is in the user's saved Model Selections (always
 * true for a model that does not go through a router).
 */
export function isRouterModelSelected(
  modelId: string,
  selections: RouterSelections,
): boolean {
  const router = routerForModelId(modelId);
  return (
    !router || selections[router].includes(modelId.slice(router.length + 1))
  );
}

/**
 * The ids a composer accepts as a selection: the static catalog, any
 * deployment-configured model, local models and router-prefixed ids.
 */
export function isAllowedModelId(
  id: string,
  configuredModelIds: readonly string[] = [],
): boolean {
  return (
    ALLOWED_MODEL_IDS.has(id) ||
    configuredModelIds.includes(id) ||
    id.startsWith("ollama/") ||
    routerForModelId(id) !== null
  );
}

// ---------------------------------------------------------------------------
// Picker rows
// ---------------------------------------------------------------------------

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

/** Model maker used for grouping; the router remains a separate source. */
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

/**
 * A Bedrock model id ("us.anthropic.claude-opus-5-5", "meta.llama4-v1:0", or
 * an inference-profile ARN) as vendor/model, with the geo prefix and version
 * suffix that only matter to AWS removed.
 */
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

/** Protocol prefixes select the wire format, not the display name. */
export function withoutExplicitProtocol(modelId: string): string {
  return modelId.replace(/^(?:anthropic|openai|gemini):/, "");
}

/**
 * A Vertex AI model id without the parts that only matter to Google: the
 * version pin on Claude ("claude-opus-5-5@20260101") and the "-maas" suffix
 * on partner models ("meta/llama-4-maverick-maas").
 */
export function vertexCatalogModel(modelId: string): string {
  return withoutExplicitProtocol(modelId)
    .replace(/@[^/]*$/, "")
    .replace(/-maas$/, "");
}

/**
 * How each router's saved ids become picker rows: the source label shown for
 * duplicates, the id the label and vendor group are read from (Bedrock and
 * Vertex strip cloud-only decoration), and a fixed group where the router
 * only serves one maker. Azure and Foundry deployments are named by their
 * owner, so the name is the label.
 */
const ROUTER_OPTIONS: Record<
  RouterSlug,
  {
    source: string;
    catalogModel?: (model: string) => string;
    group?: string;
  }
> = {
  openrouter: { source: "OpenRouter" },
  vercel: { source: "Vercel" },
  "opencode-go": { source: "OpenCode" },
  bedrock: { source: "Bedrock", catalogModel: bedrockCatalogModel },
  azure: { source: "Azure" },
  "azure-foundry": { source: "Foundry", catalogModel: withoutExplicitProtocol },
  vertex: { source: "Vertex", catalogModel: vertexCatalogModel },
  xai: { source: "xAI", group: "xAI" },
  custom: { source: "Custom" },
};

/**
 * Picker rows for one router's saved Model Selections. The app-level id
 * always prefixes the router slug verbatim, with no inner stripping, so both
 * clients send the identical string for the same stored selection
 * ("openrouter/openrouter/auto" for OpenRouter's "openrouter/auto").
 */
export function routerModelOptions(
  router: RouterSlug,
  models: readonly string[],
): ModelOption[] {
  const { source, catalogModel = (model: string) => model, group } =
    ROUTER_OPTIONS[router];
  return models.map((model) => {
    const catalogId = catalogModel(model);
    return {
      id: `${router}/${model}`,
      label: modelDisplayName(catalogId),
      group: group ?? underlyingProviderGroup(catalogId, router),
      source,
    };
  });
}

/** Picker rows for every router's saved Model Selections, in router order. */
export function allRouterModelOptions(
  selections: Partial<RouterSelections>,
): ModelOption[] {
  return ROUTER_SLUGS.flatMap((slug) =>
    routerModelOptions(slug, selections[slug] ?? []),
  );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** The key provider behind a model; "ollama" is local and needs no key. */
export type ModelProvider =
  | "claude"
  | "gemini"
  | "openai"
  | "mistral"
  | RouterSlug
  | "ollama";

/** Key providers that serve chat models (CourtListener does not). */
const MODEL_KEY_PROVIDERS = [
  "claude",
  "gemini",
  "openai",
  "mistral",
  ...ROUTER_SLUGS,
] as const;

/**
 * What a client knows about one provider's key: `configured` when a usable
 * key exists (GET /user/api-keys reports a switched-off key as not
 * configured) and `enabled: false` when a saved key is switched off.
 */
export interface ProviderKeyState {
  configured: boolean;
  enabled?: boolean;
}
export type ProviderKeyStates = Partial<
  Record<string, ProviderKeyState | undefined>
>;

export function modelGroupToProvider(group: ModelOption["group"]): ModelProvider {
  if (group === "Anthropic") return "claude";
  if (group === "OpenAI") return "openai";
  if (group === "Mistral AI") return "mistral";
  if (group === "OpenRouter") return "openrouter";
  if (group === "Vercel AI Gateway") return "vercel";
  if (group === "OpenCode Go") return "opencode-go";
  if (group === "Local") return "ollama";
  return "gemini";
}

/** The key provider that serves a model id, or null for an unknown id. */
export function getModelProvider(modelId: string): ModelProvider | null {
  if (modelId.startsWith("ollama/")) return "ollama"; // dynamic, not in the static list
  const router = routerForModelId(modelId);
  if (router) return router;
  const model = SETTINGS_MODELS.find(
    (item) => item.id === canonicalModelId(modelId),
  );
  return model ? modelGroupToProvider(model.group) : null;
}

/** A provider can serve models: its key is present and not switched off. */
export function isProviderAvailable(
  provider: ModelProvider,
  keys: ProviderKeyStates,
): boolean {
  if (provider === "ollama") return true; // local, no key needed
  return !!keys[provider]?.configured && keys[provider]?.enabled !== false;
}

export function isModelAvailable(
  modelId: string,
  keys: ProviderKeyStates,
  configuredModelIds: readonly string[] = [],
): boolean {
  if (configuredModelIds.includes(modelId)) return true;
  const provider = getModelProvider(modelId);
  return provider ? isProviderAvailable(provider, keys) : false;
}

const PROVIDER_NAMES: Record<
  ModelProvider,
  { name: string; product?: string }
> = {
  claude: { name: "Anthropic", product: "Claude" },
  gemini: { name: "Google", product: "Gemini" },
  openai: { name: "OpenAI" },
  mistral: { name: "Mistral AI" },
  openrouter: { name: "OpenRouter" },
  vercel: { name: "Vercel AI Gateway" },
  "opencode-go": { name: "OpenCode Go" },
  bedrock: { name: "Amazon Bedrock" },
  azure: { name: "Azure OpenAI" },
  "azure-foundry": { name: "Azure AI Foundry" },
  vertex: { name: "Google Vertex AI" },
  xai: { name: "xAI" },
  custom: { name: "OpenAI-compatible endpoint" },
  ollama: { name: "Local", product: "Ollama" },
};

/**
 * A provider's name for messages: "Anthropic (Claude)" by default, or just
 * "Anthropic" with `{ withProduct: false }` (the Word add-in's shorter copy).
 */
export function providerLabel(
  provider: ModelProvider,
  { withProduct = true }: { withProduct?: boolean } = {},
): string {
  const { name, product } = PROVIDER_NAMES[provider];
  return withProduct && product ? `${name} (${product})` : name;
}

/**
 * Why a composer cannot send with a model the picker does not offer: turn
 * a switched-off provider back on, or add the missing key.
 */
export function unavailableModelMessage(
  modelId: string,
  keys: ProviderKeyStates,
): string {
  const provider = getModelProvider(modelId);
  const label = provider
    ? providerLabel(provider, { withProduct: false })
    : "model provider";
  if (provider && keys[provider]?.enabled === false) {
    return `${label} is turned off. Turn it back on in Bring Your Own Keys before using this model.`;
  }
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `Add ${article} ${label} API key before using this model.`;
}

// ---------------------------------------------------------------------------
// Empty picker
// ---------------------------------------------------------------------------

export type NoModelsReason =
  | "api-keys"
  | "router-models"
  | "providers-disabled";

/**
 * Why the model list is empty, so the warning can point at the fix:
 * - "router-models": a router is connected and switched on but has no
 *   saved Model Selections;
 * - "providers-disabled": keys are saved but every one is switched off
 *   (GET /user/api-keys reports those as not configured, enabled: false);
 * - "api-keys": nothing usable is saved, or key state is unknown.
 */
export function noModelsReason(
  keys: ProviderKeyStates | null | undefined,
  selections: Partial<RouterSelections>,
): NoModelsReason {
  if (!keys) return "api-keys";
  const configuredRouterWithoutModels = ROUTER_SLUGS.some(
    (slug) =>
      isProviderAvailable(slug, keys) && (selections[slug]?.length ?? 0) === 0,
  );
  if (configuredRouterWithoutModels) return "router-models";
  const switchedOffKey = MODEL_KEY_PROVIDERS.some(
    (provider) => keys[provider]?.enabled === false,
  );
  return switchedOffKey ? "providers-disabled" : "api-keys";
}

export const NO_MODELS_MESSAGES: Record<NoModelsReason, string> = {
  "router-models":
    "Your router is connected, but it has no saved models. Open your provider in Bring Your Own Keys and add a model under Model Selections.",
  "providers-disabled":
    "Your saved API keys are all turned off. Turn a provider back on in Bring Your Own Keys to select a model.",
  "api-keys":
    "Add an API key in Bring Your Own Keys before selecting a model.",
};
