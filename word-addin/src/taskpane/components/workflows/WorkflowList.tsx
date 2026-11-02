import React, { useMemo } from "react";
import type { Workflow } from "../../types";
import { PickerList } from "../primitives/PickerList";

interface WorkflowListProps {
  workflows: Workflow[];
  search: string;
  onSearchChange: (search: string) => void;
  onSelect: (workflow: Workflow) => void;
  loading?: boolean;
  error?: string | null;
  /**
   * The load failed and a toast already says so (with Retry): show no list
   * and no "nothing found" copy, which would claim there are no workflows.
   */
  loadFailed?: boolean;
  selectedId?: string;
  emptyMessage?: string;
}

export function WorkflowList({
  workflows,
  onSelect,
  emptyMessage = "No assistant workflows found",
  ...listProps
}: WorkflowListProps): React.ReactElement {
  const items = useMemo(
    () =>
      workflows.map((workflow) => ({
        id: workflow.id,
        title: workflow.metadata.title,
        meta: workflow.metadata.practice,
        // A workflow with no prompt has nothing to run.
        disabled: !(workflow.skill_md ?? "").trim(),
      })),
    [workflows],
  );

  return (
    <PickerList
      {...listProps}
      items={items}
      emptyMessage={emptyMessage}
      searchPlaceholder="Search workflows..."
      loadingLabel="Loading workflows…"
      onSelect={(id) => {
        const workflow = workflows.find((item) => item.id === id);
        if (workflow) onSelect(workflow);
      }}
    />
  );
}
