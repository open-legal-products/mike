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
  DropdownTrigger,
} from "./DropdownUI";

export type ModelToggleGroup =
  | "Anthropic"
  | "Google"
  | "OpenAI"
  | "OpenRouter"
  | "Vercel AI Gateway"
  | "OpenCode Go"
  | "Committee"
  | "Local";

export interface ModelToggleOption {
  id: string;
  label: string;
  group: ModelToggleGroup;
}

export const MODEL_TOGGLE_GROUPS: readonly ModelToggleGroup[] = [
  "Anthropic",
  "Google",
  "OpenAI",
  "OpenRouter",
  "Vercel AI Gateway",
  "OpenCode Go",
  "Committee",
  "Local",
];

export interface ModelToggleUIProps {
  value: string;
  onChange: (id: string) => void;
  models: readonly ModelToggleOption[];
  selectedLabel?: string;
  selectedAvailable?: boolean;
  loading?: boolean;
  compact?: boolean;
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
}: ModelToggleUIProps) {
  const [open, setOpen] = React.useState(false);
  const selected = models.find((model) => model.id === value);
  const [expandedGroup, setExpandedGroup] =
    React.useState<ModelToggleGroup | null>(null);
  const availableGroups = MODEL_TOGGLE_GROUPS.flatMap((group) => {
    const items = models.filter((model) => model.group === group);
    return items.length ? [{ group, items }] : [];
  });
  const label =
    selectedLabel ??
    selected?.label ??
    (models.length > 0 ? "Select model" : "No API Key");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setExpandedGroup(selected?.group ?? availableGroups[0]?.group ?? null);
    }
  };

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
          disabled={loading || models.length === 0}
          className={`flex h-8 shrink-0 items-center rounded-lg text-sm text-gray-400 transition-colors enabled:cursor-pointer enabled:hover:text-gray-700 disabled:cursor-default disabled:hover:text-gray-400 ${compact ? "w-8 justify-center px-0" : "gap-1.5 px-2"} ${open ? "text-gray-700" : ""}`}
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
              <span className="max-w-[200px] truncate">{label}</span>
              <ChevronDown
                className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              />
            </>
          )}
        </button>
      </DropdownTrigger>
      <DropdownContent
        side="top"
        align="end"
        sideOffset={8}
        className="max-h-[min(420px,70vh)] w-56 overflow-y-auto rounded-2xl text-gray-700"
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
                    {model.id === value && (
                      <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                    )}
                  </DropdownItem>
                ))}
            </React.Fragment>
          );
        })}
      </DropdownContent>
    </Dropdown>
  );
}
