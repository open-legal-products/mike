"use client";

import { useEffect } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ReasoningLevel,
} from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
  MODELS,
  allRouterModelOptions,
  modelDisplayName,
  noModelsReason,
  type ModelOption,
  type NoModelsReason,
  type RouterSelections,
} from "@/shared/lib/modelCatalog";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";

export type { ReasoningLevel };

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
  /** Each router's saved Model Selections; omitted while none are known. */
  routerSelections?: Partial<RouterSelections>;
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

export function ModelToggle({
  value,
  onChange,
  apiKeys,
  apiKeysLoading = false,
  routerSelections = {},
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
    ...allRouterModelOptions(routerSelections),
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
  const emptyReason = noModelsReason(apiKeys, routerSelections);
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
