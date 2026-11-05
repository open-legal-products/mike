import React, { useState } from "react";
import { Check, Eye, Pen } from "lucide-react";
import type { WordEditApplyMode } from "../../lib/wordChatSettings";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@mike/ui";

interface ApplyModeOption {
  mode: WordEditApplyMode;
  label: string;
  description: string;
  Icon: typeof Eye;
}

const REVIEW_OPTION: ApplyModeOption = {
  mode: "approval",
  label: "Review",
  description: "Review proposed changes before applying them to the document",
  Icon: Eye,
};
const DIRECT_OPTION: ApplyModeOption = {
  mode: "direct",
  label: "Edit",
  description: "Apply streamed edits immediately as tracked changes",
  Icon: Pen,
};
const OPTIONS = [REVIEW_OPTION, DIRECT_OPTION];

/**
 * Composer control choosing how streamed edits reach the document: a compact
 * pill showing the active mode that opens a two-option menu (title +
 * consequence per option), in the style of the model picker beside it.
 */
export function EditApplyModeMenu({
  mode,
  onModeChange,
}: {
  mode: WordEditApplyMode;
  onModeChange: (mode: WordEditApplyMode) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = mode === "direct" ? DIRECT_OPTION : REVIEW_OPTION;

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label="Choose how edits are applied"
          title="Choose how edits are applied"
          data-testid="edit-apply-toggle"
          className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-1.5 text-sm text-gray-400 transition-colors hover:text-gray-700 ${
            open ? "text-gray-700" : ""
          }`}
        >
          <active.Icon className="h-3.5 w-3.5 shrink-0" />
          <span>{active.label}</span>
        </button>
      </DropdownTrigger>
      <DropdownContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)]"
      >
        {OPTIONS.map((option) => (
          <DropdownItem
            key={option.mode}
            onSelect={() => onModeChange(option.mode)}
            selected={option.mode === mode}
            className="flex-col items-stretch gap-0.5 py-2"
          >
            <span className="flex items-center gap-2">
              <option.Icon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
              <span className="flex-1 text-xs font-medium text-gray-800">
                {option.label}
              </span>
              {option.mode === mode && (
                <Check className="h-3.5 w-3.5 shrink-0 text-gray-600" />
              )}
            </span>
            <span className="pl-[22px] text-xs text-gray-500">
              {option.description}
            </span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
