"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import {
  Dropdown,
  DropdownCheckboxItem,
  DropdownContent,
  DropdownTrigger,
  TextButtonUI,
} from "@mike/ui";
import type { PlaybookListOption } from "./playbookJurisdictions";

function parseList(text: string) {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A comma-separated list in a playbook's details, such as document types. The
 * field keeps the typed text so a trailing comma survives until the next entry
 * is typed. With `options`, a menu beside the text also adds and removes
 * common entries.
 */
export function PlaybookListField({
  label,
  value,
  onChange,
  placeholder,
  options,
  disabled = false,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  options?: readonly PlaybookListOption[];
  disabled?: boolean;
}) {
  const id = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [menuWidth, setMenuWidth] = useState<number>();
  const [text, setText] = useState(() => value.join(", "));
  // Adopt a list replaced from outside, such as a reset draft.
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if (parseList(text).join("\n") !== value.join("\n"))
      setText(value.join(", "));
  }
  const entries = parseList(text);
  const has = (option: string) =>
    entries.some((entry) => entry.toLowerCase() === option.toLowerCase());
  function toggle(option: string) {
    const next = has(option)
      ? entries.filter((entry) => entry.toLowerCase() !== option.toLowerCase())
      : [...entries, option];
    setText(next.join(", "));
    onChange(next);
  }
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div ref={fieldRef} className="relative">
        <FormTextInput
          id={id}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          className={options ? "pr-10" : undefined}
          onChange={(event) => {
            setText(event.target.value);
            onChange(parseList(event.target.value));
          }}
        />
        {options && (
          <Dropdown
            // The menu opens from the chevron but spans the whole input.
            onOpenChange={(open) => {
              if (open) setMenuWidth(fieldRef.current?.offsetWidth);
            }}
          >
            <DropdownTrigger asChild>
              <TextButtonUI
                type="button"
                size="icon-xs"
                disabled={disabled}
                aria-label={`Choose ${label.toLowerCase()}`}
                title={`Choose ${label.toLowerCase()}`}
                className="absolute right-2 top-1/2 h-6 -translate-y-1/2"
              >
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              </TextButtonUI>
            </DropdownTrigger>
            <DropdownContent
              align="end"
              // The chevron sits 8px inside the input's right and bottom
              // edges; these line the menu up with the input instead.
              alignOffset={-8}
              sideOffset={12}
              collisionPadding={12}
              style={{ width: menuWidth }}
              className="max-h-72 overflow-y-auto"
            >
              {options.map((option) => (
                <DropdownCheckboxItem
                  key={option.value}
                  checked={has(option.value)}
                  onCheckedChange={() => toggle(option.value)}
                  // Stays open so several can be chosen in a row.
                  onSelect={(event) => event.preventDefault()}
                  className={option.nested ? "pl-6" : undefined}
                >
                  {option.label}
                </DropdownCheckboxItem>
              ))}
            </DropdownContent>
          </Dropdown>
        )}
      </div>
    </div>
  );
}
