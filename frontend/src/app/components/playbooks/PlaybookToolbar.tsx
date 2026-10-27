"use client";

import { Plus, Upload } from "lucide-react";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TabPillButtonUI } from "@mike/ui";

// A playbook's details are edited from a dialog, as in other features.
export const PLAYBOOK_VIEWS = ["rules", "references", "runs"] as const;
export type PlaybookView = (typeof PLAYBOOK_VIEWS)[number];

const VIEWS: { id: PlaybookView; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "references", label: "References" },
  { id: "runs", label: "Runs" },
];

export function PlaybookToolbar({
  disabled,
  canEdit,
  view,
  onViewChange,
  onAddRule,
  onUpload,
  onNewRun,
}: {
  disabled: boolean;
  canEdit: boolean;
  view: PlaybookView;
  onViewChange: (view: PlaybookView) => void;
  onAddRule: () => void;
  /** Adds a reference document; shown on References. */
  onUpload: () => void;
  /** Opens the new-run form; shown on Runs. */
  onNewRun: () => void;
}) {
  return (
    <nav aria-label="Playbook toolbar" className="shrink-0">
      <TableToolbar
        leading={
          <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
            <div
              role="group"
              aria-label="Playbook view"
              className="flex flex-wrap items-center gap-1.5"
            >
              {VIEWS.map((entry) => (
                <TabPillButtonUI
                  key={entry.id}
                  active={view === entry.id}
                  onClick={() => onViewChange(entry.id)}
                >
                  {entry.label}
                </TabPillButtonUI>
              ))}
            </div>
            {view === "rules" && (
              <TabPillButtonUI
                disabled={disabled || !canEdit}
                onClick={onAddRule}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                New rule
              </TabPillButtonUI>
            )}
            {view === "runs" && (
              <TabPillButtonUI disabled={disabled} onClick={onNewRun}>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                New run
              </TabPillButtonUI>
            )}
            {view === "references" && (
              <TabPillButtonUI
                disabled={disabled || !canEdit}
                onClick={onUpload}
              >
                <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                Upload
              </TabPillButtonUI>
            )}
          </div>
        }
      />
    </nav>
  );
}
