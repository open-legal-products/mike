import React, { useEffect, useRef } from "react";
import type { Workflow } from "../../types";
import { workflowSlashCommandFromTitle } from "@mike/ui";

export const WORD_WORKFLOW_SLASH_MENU_ID = "word-workflow-slash-menu";

export function WorkflowSlashMenu({
  workflows,
  activeIndex,
  onSelect,
}: {
  workflows: Workflow[];
  activeIndex: number;
  onSelect: (workflow: Workflow) => void;
}): React.ReactElement | null {
  const activeOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (workflows.length === 0) return null;

  return (
    <div
      id={WORD_WORKFLOW_SLASH_MENU_ID}
      role="listbox"
      aria-label="Workflow commands"
      className="liquid-glass-translucent absolute bottom-full left-0 z-10 mb-1.5 grid max-h-56 w-full gap-1 overflow-y-auto rounded-[18px] p-1 overscroll-contain"
    >
      {workflows.map((workflow, index) => {
        const command = workflowSlashCommandFromTitle(workflow.metadata.title);
        if (!command) return null;
        const active = index === activeIndex;
        return (
          <button
            ref={active ? activeOptionRef : undefined}
            key={workflow.id}
            id={`${WORD_WORKFLOW_SLASH_MENU_ID}-${index}`}
            type="button"
            role="option"
            aria-label={`${command} ${workflow.metadata.title}`}
            aria-selected={active}
            onClick={() => onSelect(workflow)}
            className={`theme-dropdown-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
              active
                ? "theme-dropdown-selected text-gray-900"
                : "text-gray-700"
            }`}
          >
            <span className="font-medium text-gray-900">{command}</span>
            <span className="truncate text-gray-500">
              {workflow.metadata.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}
