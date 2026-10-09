import React, { useEffect, useState } from "react";
import type { Workflow } from "../../types";
import { listWorkflows } from "../../api/mikeApi";
import { Modal } from "../primitives/Modal";
import { WorkflowList } from "./WorkflowList";
import { userMessage } from "../../lib/notify";

interface WorkflowModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (workflow: Workflow) => void;
  initialWorkflowId?: string;
}

export function WorkflowModal({
  open,
  onClose,
  onSelect,
  initialWorkflowId,
}: WorkflowModalProps): React.ReactElement | null {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState(initialWorkflowId ?? "");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearch("");
    setSelectedId(initialWorkflowId ?? "");
    listWorkflows("assistant")
      .then((items) => {
        if (cancelled) return;
        setWorkflows(
          (items ?? []).filter((item) => item.metadata.type === "assistant")
        );
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setWorkflows([]);
        setError(
          userMessage(reason, {
            fallback: "Mike couldn't load your workflows. Try again.",
          })
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialWorkflowId, open]);

  const selected = workflows.find((workflow) => workflow.id === selectedId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add workflow"
      primaryAction={{
        label: "Use",
        disabled: !selected || !(selected.skill_md ?? "").trim(),
        onClick: () => {
          if (!selected || !(selected.skill_md ?? "").trim()) return;
          onSelect(selected);
          onClose();
        },
      }}
    >
      <WorkflowList
        workflows={workflows}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
        error={error}
        selectedId={selectedId}
        onSelect={(workflow) =>
          setSelectedId(workflow.id === selectedId ? "" : workflow.id)
        }
      />
    </Modal>
  );
}
