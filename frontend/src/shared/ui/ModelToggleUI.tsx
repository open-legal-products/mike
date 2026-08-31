"use client";

import * as React from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "./DropdownUI";
import {
  LIQUID_GLASS_FLOAT_CLASS,
  LIQUID_GLASS_HOVER_CLASS,
  LIQUID_GLASS_SELECTED_CLASS,
  LIQUID_GLASS_SUBTLE_CLASS,
} from "./LiquidGlassUI";

export type ModelToggleGroup = string;

export interface ModelToggleOption {
  id: string;
  label: string;
  group: ModelToggleGroup;
  /** Execution path shown when the same model is available more than once. */
  source?: string;
}

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const STANDARD_REASONING_LEVELS: readonly ReasoningLevel[] =
  REASONING_LEVELS.filter((level) => level !== "max");
const GPT_56_REASONING_LEVELS: readonly ReasoningLevel[] = REASONING_LEVELS;

/** Explicit AI SDK reasoning levels supported by the selected model family. */
export function reasoningLevelsForModel(
  modelId: string,
): readonly ReasoningLevel[] {
  const catalogId = modelId.replace(/^(?:openrouter|orcarouter|vercel)\//, "");
  if (/(?:^|\/)gpt-5\.6(?:-|$)/.test(catalogId)) {
    return GPT_56_REASONING_LEVELS;
  }
  return STANDARD_REASONING_LEVELS;
}

/** Move a stale saved level to the nearest level supported by the model. */
export function nearestReasoningLevelForModel(
  modelId: string,
  level: ReasoningLevel,
): ReasoningLevel {
  const supported = reasoningLevelsForModel(modelId);
  if (supported.includes(level)) return level;
  const requestedIndex = REASONING_LEVELS.indexOf(level);
  return supported.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(
      REASONING_LEVELS.indexOf(nearest) - requestedIndex,
    );
    const candidateDistance = Math.abs(
      REASONING_LEVELS.indexOf(candidate) - requestedIndex,
    );
    return candidateDistance <= nearestDistance ? candidate : nearest;
  }, supported[0] ?? "high");
}

export const MODEL_TOGGLE_GROUPS: readonly ModelToggleGroup[] = [
  "Anthropic",
  "Google",
  "OpenAI",
  "Moonshot AI",
  "Zhipu AI",
  "MiniMax",
  "Alibaba",
  "DeepSeek",
  "Xiaomi",
  "Mistral AI",
  "Local",
  "Other providers",
];

export function orderedModelGroups(
  models: readonly ModelToggleOption[],
): ModelToggleGroup[] {
  const present = new Set(models.map((model) => model.group));
  const known = MODEL_TOGGLE_GROUPS.filter((group) => present.delete(group));
  return [...known, ...[...present].sort((a, b) => a.localeCompare(b))];
}

export interface ModelToggleUIProps {
  value: string;
  onChange: (id: string) => void;
  models: readonly ModelToggleOption[];
  selectedLabel?: string;
  selectedAvailable?: boolean;
  loading?: boolean;
  compact?: boolean;
  modalInput?: boolean;
  emptyLabel?: string;
  onEmptyClick?: () => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
  reasoningLevels?: readonly ReasoningLevel[];
}

const itemClassName =
  "theme-dropdown-item flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-gray-700 outline-none transition-colors focus:text-gray-900 data-[highlighted]:text-gray-900 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>*]:pointer-events-none";

/**
 * Platform-neutral model-picker presentation. Hosts own model discovery and
 * availability; this component owns the responsive trigger and dropdown UI.
 */
export function ModelToggleUI({
  value,
  onChange,
  models,
  selectedLabel,
  selectedAvailable = true,
  loading = false,
  compact = false,
  modalInput = false,
  emptyLabel = "No Models",
  onEmptyClick,
  reasoningLevel,
  onReasoningChange,
  reasoningLevels = REASONING_LEVELS,
}: ModelToggleUIProps) {
  const [open, setOpen] = React.useState(false);
  const reasoningInputRef = React.useRef<HTMLInputElement>(null);
  const selected = models.find((model) => model.id === value);
  const [expandedGroup, setExpandedGroup] =
    React.useState<ModelToggleGroup | null>(null);
  const availableGroups = orderedModelGroups(models).flatMap((group) => {
    const items = models.filter((model) => model.group === group);
    return items.length ? [{ group, items }] : [];
  });
  const routeCounts = models.reduce((counts, model) => {
    const key = `${model.group}\u0000${model.label.toLocaleLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const label =
    selectedLabel ??
    selected?.label ??
    (models.length > 0 ? "Select model" : emptyLabel);
  const reasoningIndex = reasoningLevel
    ? Math.max(0, reasoningLevels.indexOf(reasoningLevel))
    : 0;
  const reasoningProgress =
    (reasoningIndex / Math.max(1, reasoningLevels.length - 1)) * 100;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setExpandedGroup(selected?.group ?? availableGroups[0]?.group ?? null);
    }
  };

  if (!loading && models.length === 0) {
    return (
      <button
        type="button"
        aria-label="No models available"
        title="Configure models"
        onClick={onEmptyClick}
        disabled={!onEmptyClick}
        className={
          modalInput
            ? `flex h-10 w-full items-center rounded-xl px-3 text-sm text-gray-400 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS} backdrop-blur-xl transition-colors enabled:cursor-pointer enabled:hover:text-gray-700 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2`
            : "flex h-8 shrink-0 items-center rounded-lg px-2 text-sm text-gray-400 transition-colors enabled:cursor-pointer enabled:hover:text-gray-700 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
        }
      >
        <span className="max-w-[200px] truncate">{emptyLabel}</span>
      </button>
    );
  }

  return (
    <Dropdown open={open} onOpenChange={handleOpenChange}>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label="Choose model"
          title={
            loading
              ? "Checking API keys"
              : models.length === 0
                ? "No API key configured"
                : selectedAvailable
                  ? `Choose model — ${label}`
                  : "API key missing for selected model"
          }
          disabled={loading}
          className={
            modalInput
              ? `flex h-10 w-full items-center justify-between gap-2 rounded-xl px-3 text-sm text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS} backdrop-blur-xl transition-colors enabled:cursor-pointer disabled:cursor-default disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${open ? LIQUID_GLASS_SELECTED_CLASS : ""}`
              : `flex h-8 shrink-0 items-center rounded-lg text-sm text-gray-400 transition-colors enabled:cursor-pointer enabled:hover:text-gray-700 disabled:cursor-default disabled:hover:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 ${compact ? "w-8 justify-center px-0" : "gap-1.5 px-2"} ${open ? "text-gray-700" : ""}`
          }
        >
          {compact ? (
            loading ? (
              <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
            ) : selectedAvailable ? (
              <Settings2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
            )
          ) : (
            <>
              <span
                className={`${modalInput ? "min-w-0 flex-1 text-left" : "max-w-[200px]"} truncate`}
              >
                {label}
              </span>
              <ChevronDown
                className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              />
            </>
          )}
        </button>
      </DropdownTrigger>
      <DropdownContent
        side={modalInput ? "bottom" : "top"}
        align={modalInput ? "start" : "end"}
        sideOffset={modalInput ? 4 : 8}
        className={`max-h-[min(420px,70vh)] overflow-y-auto rounded-2xl text-gray-700 ${modalInput ? "w-[var(--radix-dropdown-menu-trigger-width)]" : "w-56"}`}
      >
        {availableGroups.map(({ group, items }) => {
          const expanded = expandedGroup === group;
          return (
            <React.Fragment key={group}>
              <DropdownItem
                aria-expanded={expanded}
                className={`${itemClassName} py-2 font-medium`}
                onSelect={(event) => {
                  event.preventDefault();
                  setExpandedGroup(expanded ? null : group);
                }}
              >
                <span className="flex-1">{group}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-gray-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                />
              </DropdownItem>
              {expanded &&
                items.map((model) => (
                  <DropdownItem
                    key={model.id}
                    selected={model.id === value}
                    className={`${itemClassName} ${model.id === value ? "text-gray-900" : ""}`}
                    onSelect={() => onChange(model.id)}
                  >
                    <span className="flex-1">{model.label}</span>
                    {model.source &&
                      (routeCounts.get(
                        `${model.group}\u0000${model.label.toLocaleLowerCase()}`,
                      ) ?? 0) > 1 && (
                        <span className="text-[9px] font-medium text-gray-400">
                          {model.source}
                        </span>
                      )}
                    {model.id === value && (
                      <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                    )}
                  </DropdownItem>
                ))}
            </React.Fragment>
          );
        })}
        {reasoningLevel !== undefined && onReasoningChange && (
          <>
            <DropdownSeparator />
            <DropdownItem
              aria-label={`Reasoning level: ${REASONING_LEVEL_LABELS[reasoningLevel]}`}
              onSelect={(event) => event.preventDefault()}
              onFocus={(event) => {
                if (event.target === event.currentTarget) {
                  reasoningInputRef.current?.focus();
                }
              }}
              className="block cursor-default rounded-md px-2.5 py-2 [&>*]:pointer-events-auto"
            >
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-xs text-gray-700">
                  <span className="font-medium">Reasoning</span>
                  <span className="ml-auto text-[10px] text-gray-500">
                    {REASONING_LEVEL_LABELS[reasoningLevel]}
                  </span>
                </div>
                <div className="relative h-4 w-full rounded-full bg-gray-200/80 transition-shadow duration-150 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-blue-500/40 has-[input:focus-visible]:ring-offset-2">
                  <span aria-hidden="true" className="absolute inset-0">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-blue-600/60 via-blue-600 to-blue-700 transition-[width] duration-150 ease-out"
                      style={{
                        width: `calc(${reasoningProgress}% + ${1 - reasoningProgress / 100}rem)`,
                      }}
                    />
                    <span
                      className={`absolute top-1/2 h-3 w-3 rounded-full bg-white transition-[left,transform] duration-150 ease-out ${LIQUID_GLASS_FLOAT_CLASS}`}
                      style={{
                        left: `calc(${reasoningProgress}% + ${0.125 - reasoningProgress / 100}rem)`,
                        transform: "translateY(-50%)",
                      }}
                    />
                  </span>
                  <input
                    ref={reasoningInputRef}
                    type="range"
                    aria-label="Reasoning level"
                    aria-valuetext={REASONING_LEVEL_LABELS[reasoningLevel]}
                    min={0}
                    max={reasoningLevels.length - 1}
                    step={1}
                    value={reasoningIndex}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      const offsets: Partial<Record<string, number>> = {
                        ArrowLeft: -1,
                        ArrowDown: -1,
                        ArrowRight: 1,
                        ArrowUp: 1,
                        PageDown: -1,
                        PageUp: 1,
                      };
                      const offset = offsets[event.key];
                      const nextIndex =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? reasoningLevels.length - 1
                            : offset
                              ? Math.min(
                                  reasoningLevels.length - 1,
                                  Math.max(0, reasoningIndex + offset),
                                )
                              : null;
                      if (nextIndex === null) return;
                      event.preventDefault();
                      event.stopPropagation();
                      onReasoningChange(
                        reasoningLevels[nextIndex] ?? reasoningLevel,
                      );
                    }}
                    onChange={(event) =>
                      onReasoningChange(
                        reasoningLevels[Number(event.currentTarget.value)] ??
                          "high",
                      )
                    }
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </div>
              </div>
            </DropdownItem>
          </>
        )}
      </DropdownContent>
    </Dropdown>
  );
}
