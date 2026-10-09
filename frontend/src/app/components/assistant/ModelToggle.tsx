"use client";

import { useEffect } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ModelToggleOption,
  type ReasoningLevel,
} from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import {
  ROUTER_SLUGS,
  type RouterModelSelections,
  type RouterSlug,
} from "@/app/lib/routerModels";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";

export type ModelOption = ModelToggleOption;
export type { ReasoningLevel };

export const MODELS: ModelOption[] = [
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

export const SETTINGS_MODELS: ModelOption[] = [
  ...MODELS,
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    group: "Google",
  },
];

for (const model of MODELS) model.source = "Direct";
for (const model of SETTINGS_MODELS) model.source ??= "Direct";

export const DEFAULT_MODEL_ID = "";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

// Renamed/retired static ids → their current equivalents. Stored preferences
// (profile fields, localStorage selections) outlive catalog renames; mapping
// them on read keeps an old saved value working instead of orphaning it.
// Kept in sync with backend/src/lib/llm/models.ts LEGACY_MODEL_IDS.
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
      if (MODEL_NAME_ACRONYMS[lower]) {
        return MODEL_NAME_ACRONYMS[lower];
      }
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

export {
  ROUTER_PROFILE_FIELDS,
  ROUTER_SLUGS,
  routerModelsFromProfile,
  type RouterModelSelections,
  type RouterProfileField,
  type RouterSlug,
} from "@/app/lib/routerModels";

const NO_ROUTER_MODELS: RouterModelSelections = {};

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

interface Props {
  value: string;
  onChange: (id: string) => void;
  /**
   * Loaded key state, or undefined when it is UNKNOWN (profile still
   * loading, or the fetch failed and the app degrades). Unknown state fails
   * open — the backend authoritatively rejects models it cannot serve.
   */
  apiKeys?: ApiKeyState;
  /** True while the profile is still loading: render a neutral disabled
   *  trigger instead of flashing "No Models" on every page load. */
  apiKeysLoading?: boolean;
  /** The user's saved models, per router. */
  routerModels?: RouterModelSelections;
  compact?: boolean;
  tone?: "muted" | "default";
  /** Render as a full-width liquid-glass control inside a modal form. */
  modalInput?: boolean;
  /** Extra classes for the compact trigger button, for a host row's sizing. */
  triggerClassName?: string;
  onNoModelsClick?: (reason: NoModelsReason) => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
}

export type NoModelsReason = "api-keys" | "router-models";

export function noModelsReason(
  apiKeys: ApiKeyState | undefined,
  routerModels: Partial<Record<RouterSlug, string[]>>,
): NoModelsReason {
  const configuredRouterWithoutModels = ROUTER_SLUGS.some(
    (slug) =>
      apiKeys?.[slug]?.configured === true &&
      (routerModels[slug]?.length ?? 0) === 0,
  );
  return configuredRouterWithoutModels ? "router-models" : "api-keys";
}

export function openRouterModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `openrouter/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "openrouter"),
    source: "OpenRouter",
  }));
}

export function vercelModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `vercel/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "vercel"),
    source: "Vercel",
  }));
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

export function bedrockModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => {
    const catalogModel = bedrockCatalogModel(model);
    return {
      id: `bedrock/${model}`,
      label: modelDisplayName(catalogModel),
      group: underlyingProviderGroup(catalogModel, "bedrock"),
      source: "Bedrock",
    };
  });
}

/** Azure deployments are named by their owner; the name is the label. */
export function azureModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `azure/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "azure"),
    source: "Azure",
  }));
}

/**
 * Vertex and Foundry ids may state their wire protocol up front
 * ("anthropic:prod-sonnet") when the name does not reveal it; that prefix is
 * for the backend, not part of the model's name.
 */
export function withoutExplicitProtocol(modelId: string): string {
  return modelId.replace(/^(?:anthropic|openai|gemini):/, "");
}

/** Foundry deployments are named by their owner too. */
export function azureFoundryModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => {
    const name = withoutExplicitProtocol(model);
    return {
      id: `azure-foundry/${model}`,
      label: modelDisplayName(name),
      group: underlyingProviderGroup(name, "azure-foundry"),
      source: "Foundry",
    };
  });
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

export function vertexModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => {
    const catalogModel = vertexCatalogModel(model);
    return {
      id: `vertex/${model}`,
      label: modelDisplayName(catalogModel),
      group: underlyingProviderGroup(catalogModel, "vertex"),
      source: "Vertex",
    };
  });
}

export function xaiModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `xai/${model}`,
    label: modelDisplayName(model),
    group: "xAI",
    source: "xAI",
  }));
}

/** Models behind the user's own OpenAI-compatible endpoint. */
export function customModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `custom/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "custom"),
    source: "Custom",
  }));
}

export function openCodeGoModelOptions(models: string[]): ModelOption[] {
  return models.map((model) => ({
    id: `opencode-go/${model}`,
    label: modelDisplayName(model),
    group: underlyingProviderGroup(model, "opencode-go"),
    source: "OpenCode",
  }));
}

const ROUTER_MODEL_OPTIONS: Record<
  RouterSlug,
  (models: string[]) => ModelOption[]
> = {
  openrouter: openRouterModelOptions,
  vercel: vercelModelOptions,
  "opencode-go": openCodeGoModelOptions,
  bedrock: bedrockModelOptions,
  azure: azureModelOptions,
  "azure-foundry": azureFoundryModelOptions,
  vertex: vertexModelOptions,
  xai: xaiModelOptions,
  custom: customModelOptions,
};

/** Picker options for every saved router model, in router order. */
export function routerModelOptions(
  selections: RouterModelSelections,
): ModelOption[] {
  return ROUTER_SLUGS.flatMap((slug) =>
    ROUTER_MODEL_OPTIONS[slug](selections[slug] ?? []),
  );
}

/** Deployment declarations override any static or router entry with the same id. */
export function mergeConfiguredModelOptions(
  configured: readonly ModelOption[],
  other: readonly ModelOption[],
): ModelOption[] {
  const configuredIds = new Set(configured.map((model) => model.id));
  return [
    ...other.filter((model) => !configuredIds.has(model.id)),
    ...configured,
  ];
}

export function ModelToggle({
  value,
  onChange,
  apiKeys,
  apiKeysLoading = false,
  routerModels = NO_ROUTER_MODELS,
  compact = false,
  tone,
  modalInput = false,
  triggerClassName,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
}: Props) {
  const ollamaModels = useOllamaModels();
  const configuredModels = useConfiguredModels();
  const models = mergeConfiguredModelOptions(configuredModels, [
    ...MODELS,
    ...routerModelOptions(routerModels),
    ...ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Local",
    })),
  ]);
  const availableModels = models.filter((model) => {
    if (model.source === "Configured") return true;
    if (model.group === "Local") return true;
    if (apiKeysLoading) return false; // nothing offered until known
    if (!apiKeys) return true; // unknown after a failed load → fail open
    return isModelAvailable(model.id, apiKeys);
  });
  const selected = availableModels.find((model) => model.id === value);
  const supportedReasoningLevels = reasoningLevelsForModel(value);
  const normalizedReasoningLevel = reasoningLevel
    ? nearestReasoningLevelForModel(value, reasoningLevel)
    : undefined;
  useEffect(() => {
    if (
      reasoningLevel &&
      normalizedReasoningLevel &&
      normalizedReasoningLevel !== reasoningLevel &&
      onReasoningChange
    ) {
      onReasoningChange(normalizedReasoningLevel);
    }
  }, [normalizedReasoningLevel, onReasoningChange, reasoningLevel]);
  const selectedLabel = apiKeysLoading
    ? (models.find((model) => model.id === value)?.label ?? "Select model")
    : (selected?.label ??
      (availableModels.length > 0 ? "Select model" : "No Models"));
  const emptyReason = noModelsReason(apiKeys, routerModels);
  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={availableModels}
      selectedLabel={selectedLabel}
      selectedAvailable={selected !== undefined}
      loading={apiKeysLoading}
      compact={compact}
      tone={tone}
      modalInput={modalInput}
      triggerClassName={triggerClassName}
      emptyLabel="No Models"
      onEmptyClick={
        onNoModelsClick ? () => onNoModelsClick(emptyReason) : undefined
      }
      reasoningLevel={normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
    />
  );
}
