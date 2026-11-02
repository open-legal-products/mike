"use client";

import { ChevronDown } from "lucide-react";
import { authInputUIClassName } from "@/shared/ui/AuthStylesUI";
import {
  Dropdown,
  DropdownContent,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { cn } from "@/app/lib/utils";

export type SettingsSelectOption = {
  value: string;
  label: string;
  description: string;
};

/**
 * A setting chosen from a short menu. The row describes the current choice;
 * until `value` arrives it shows a placeholder and the menu stays closed.
 */
export function SettingsSelectRow({
  id,
  label,
  options,
  value,
  error = null,
  onChange,
}: {
  id: string;
  label: string;
  options: SettingsSelectOption[];
  value: string | null;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <SettingsRow>
      <div className="min-w-0 space-y-1">
        <SettingsLabel>{label}</SettingsLabel>
        {selected ? (
          <SettingsDescription>{selected.description}</SettingsDescription>
        ) : (
          <div
            className="h-5 w-56 max-w-full animate-pulse rounded bg-app-surface"
            aria-hidden="true"
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            id={id}
            type="button"
            aria-label={label}
            disabled={!selected}
            aria-busy={!selected}
            className={cn(
              "flex h-9 w-full shrink-0 items-center justify-between gap-2 text-left text-sm outline-none disabled:cursor-default disabled:opacity-60 sm:w-56",
              authInputUIClassName,
            )}
          >
            <span className="truncate">{selected?.label ?? "Loading..."}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
          </button>
        </DropdownTrigger>
        <DropdownContent
          align="end"
          sideOffset={6}
          // Long lists, such as response languages, scroll.
          className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)]"
        >
          <DropdownRadioGroup value={value ?? ""} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownRadioItem>
            ))}
          </DropdownRadioGroup>
        </DropdownContent>
      </Dropdown>
    </SettingsRow>
  );
}
