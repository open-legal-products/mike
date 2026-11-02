"use client";

import { useId } from "react";
import {
  SettingsTextInput,
  SETTINGS_CONTROL_CLASS,
} from "@/app/components/settings/SettingsTextInput";

/** Field label text, matching `FieldLabel` in the settings forms. */
export const PLAYBOOK_LABEL_CLASS = "text-sm font-medium text-gray-700";
/** Instructions or context below a field. */
export const PLAYBOOK_HELP_CLASS = "mt-1.5 text-xs text-gray-500";

/** Grows with its text where `field-sizing` is supported; resizable elsewhere. */
const TEXTAREA_BASE_CLASS = `${SETTINGS_CONTROL_CLASS} block max-h-[28rem] resize-y py-2 text-sm leading-relaxed [field-sizing:content]`;
export const PLAYBOOK_TEXTAREA_CLASS = `${TEXTAREA_BASE_CLASS} min-h-[4.75rem]`;
const ONE_LINE_TEXTAREA_CLASS = `${TEXTAREA_BASE_CLASS} min-h-10`;

export function PlaybookField({
  label,
  value,
  onChange,
  multiline = false,
  description,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** "grow" starts at one line, like an input, and wraps long text. */
  multiline?: boolean | "grow";
  /** Instructions or context, in small text below the field. */
  description?: string;
  placeholder?: string;
}) {
  const id = useId();
  const descriptionId = useId();
  const describedBy = description ? descriptionId : undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={`mb-2 block ${PLAYBOOK_LABEL_CLASS}`}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          rows={multiline === "grow" ? 1 : 3}
          className={
            multiline === "grow"
              ? ONE_LINE_TEXTAREA_CLASS
              : PLAYBOOK_TEXTAREA_CLASS
          }
        />
      ) : (
        <SettingsTextInput
          id={id}
          value={value}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description && (
        <p id={descriptionId} className={PLAYBOOK_HELP_CLASS}>
          {description}
        </p>
      )}
    </div>
  );
}
