"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { QuickAction, Workflow } from "../shared/types";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { SearchBar } from "../ui/search-bar";
import { listWorkflows } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

type Screen = "list" | "details" | "create";

interface QuickActionsModalProps {
  open: boolean;
  actions: QuickAction[];
  onSave: (action: QuickAction) => Promise<void>;
  onCreate: (input: {
    workflowId: string;
    name: string;
    prompt: string;
    documentUpload: boolean;
  }) => Promise<void>;
  onClose: () => void;
}

export function QuickActionsModal({
  open,
  actions,
  onSave,
  onCreate,
  onClose,
}: QuickActionsModalProps) {
  const [screen, setScreen] = useState<Screen>("list");
  const [selected, setSelected] = useState<QuickAction | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [documentUpload, setDocumentUpload] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || workflows.length > 0) return;
    void listWorkflows("assistant")
      .then((rows) => setWorkflows(rows))
      .catch(() => setError("Could not load assistant workflows."));
  }, [open, workflows.length]);

  const availableWorkflows = useMemo(() => {
    const used = new Set(actions.map((action) => action.workflow_id));
    return workflows.filter((workflow) => !used.has(workflow.id));
  }, [actions, workflows]);
  const filteredActions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? actions.filter((action) =>
          `${action.name} ${action.workflow.title}`
            .toLowerCase()
            .includes(query),
        )
      : actions;
  }, [actions, search]);
  const selectedHasChanges = useMemo(() => {
    if (!selected) return false;
    const original = actions.find((action) => action.id === selected.id);
    return (
      !!original &&
      (selected.workflow_id !== original.workflow_id ||
        selected.name !== original.name ||
        selected.prompt !== original.prompt ||
        selected.document_upload !== original.document_upload ||
        selected.enabled !== original.enabled)
    );
  }, [actions, selected]);

  function resetToList() {
    setScreen("list");
    setSelected(null);
    setWorkflowId("");
    setName("");
    setPrompt("");
    setDocumentUpload(false);
    setError(null);
  }

  function close() {
    resetToList();
    onClose();
  }

  async function save() {
    if (!selected || saving || !selectedHasChanges || !selected.name.trim())
      return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selected);
      resetToList();
    } catch (reason) {
      setError(userFacingApiError(reason, "Could not save quick action."));
    } finally {
      setSaving(false);
    }
  }

  async function create() {
    if (!workflowId || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        workflowId,
        name: name.trim(),
        prompt,
        documentUpload,
      });
      resetToList();
    } catch (reason) {
      setError(userFacingApiError(reason, "Could not create quick action."));
    } finally {
      setSaving(false);
    }
  }

  const breadcrumbs =
    screen === "list"
      ? ["Assistant", "Quick Actions"]
      : [
          "Assistant",
          "Quick Actions",
          screen === "create"
            ? "New Quick Action"
            : (selected?.name ?? "Quick Action"),
        ];

  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      breadcrumbs={breadcrumbs}
      secondaryAction={
        screen !== "list"
          ? {
              label: "Back",
              variant: "primary",
              onClick: resetToList,
              disabled: saving,
            }
          : undefined
      }
      cancelAction={false}
      primaryAction={
        screen === "list"
          ? {
              label: "Add",
              icon: <Plus className="h-3.5 w-3.5" />,
              variant: "blue",
              onClick: () => setScreen("create"),
              disabled: availableWorkflows.length === 0,
            }
          : screen === "create"
            ? {
                label: saving ? "Creating…" : "Create",
                variant: "blue",
                disabled: saving || !workflowId || !name.trim(),
                onClick: () => void create(),
              }
            : {
                label: saving ? "Saving…" : "Save",
                variant: "blue",
                disabled:
                  saving || !selectedHasChanges || !selected?.name.trim(),
                onClick: () => void save(),
              }
      }
    >
      {screen === "list" ? (
        <div className="flex min-h-0 flex-1 flex-col pb-5">
          <div className="pt-1 pb-2">
            <SearchBar
              value={search}
              onValueChange={setSearch}
              placeholder="Search quick actions..."
              autoFocus
            />
          </div>
          <div
            data-slot="quick-actions-list"
            className="mt-2 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pt-1"
          >
            {error && (
              <p className="px-3 py-2 text-xs text-red-600" role="alert">
                {error}
              </p>
            )}
            {filteredActions.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">
                No quick actions found.
              </p>
            ) : (
              filteredActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => {
                    setSelected(action);
                    setScreen("details");
                  }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-gray-700 transition-colors ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {action.name}
                  </span>
                  <span
                    className={
                      action.enabled
                        ? "text-xs text-green-600"
                        : "text-xs text-gray-400"
                    }
                  >
                    {action.enabled ? "Active" : "Inactive"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : screen === "create" ? (
        <QuickActionForm
          name={name}
          workflowId={workflowId}
          workflowOptions={availableWorkflows.map((workflow) => ({
            value: workflow.id,
            label: workflow.metadata.title,
          }))}
          prompt={prompt}
          documentUpload={documentUpload}
          onNameChange={setName}
          onWorkflowChange={(value) => {
            setWorkflowId(value);
            if (!name.trim()) {
              setName(
                availableWorkflows.find((workflow) => workflow.id === value)
                  ?.metadata.title ?? "",
              );
            }
          }}
          onPromptChange={setPrompt}
          onDocumentUploadChange={setDocumentUpload}
          error={error}
        />
      ) : selected ? (
        <QuickActionForm
          name={selected.name}
          workflowId={selected.workflow_id}
          workflowOptions={[
            {
              value: selected.workflow_id,
              label: selected.workflow.title,
            },
            ...availableWorkflows.map((workflow) => ({
              value: workflow.id,
              label: workflow.metadata.title,
            })),
          ]}
          prompt={selected.prompt}
          documentUpload={selected.document_upload}
          enabled={selected.enabled}
          onNameChange={(value) => setSelected({ ...selected, name: value })}
          onWorkflowChange={(value) => {
            const workflow = workflows.find((item) => item.id === value);
            if (!workflow) return;
            setSelected({
              ...selected,
              workflow_id: workflow.id,
              workflow: { id: workflow.id, title: workflow.metadata.title },
            });
          }}
          onPromptChange={(value) =>
            setSelected({ ...selected, prompt: value })
          }
          onDocumentUploadChange={(value) =>
            setSelected({ ...selected, document_upload: value })
          }
          onEnabledChange={(value) =>
            setSelected({ ...selected, enabled: value })
          }
          error={error}
        />
      ) : null}
    </Modal>
  );
}

function QuickActionForm({
  name,
  workflowId,
  workflowOptions,
  prompt,
  documentUpload,
  enabled,
  onNameChange,
  onWorkflowChange,
  onPromptChange,
  onDocumentUploadChange,
  onEnabledChange,
  error,
}: {
  name: string;
  workflowId: string;
  workflowOptions: { value: string; label: string }[];
  prompt: string;
  documentUpload: boolean;
  enabled?: boolean;
  onNameChange: (value: string) => void;
  onWorkflowChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onDocumentUploadChange: (value: boolean) => void;
  onEnabledChange?: (value: boolean) => void;
  error: string | null;
}) {
  return (
    <div
      data-slot="quick-action-form"
      className="flex min-h-0 flex-1 flex-col gap-6 px-2 pt-1 pb-5"
    >
      <div>
        <FieldLabel htmlFor="quick-action-name">Name</FieldLabel>
        <FormTextInput
          id="quick-action-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Quick action name"
          variant="minimal"
          autoFocus
        />
      </div>
      <div>
        <FieldLabel htmlFor="quick-action-workflow">Workflow used</FieldLabel>
        <ModalSelect
          id="quick-action-workflow"
          value={workflowId}
          placeholder="Select an assistant workflow"
          options={workflowOptions}
          onChange={onWorkflowChange}
        />
      </div>
      <div>
        <FieldLabel htmlFor="quick-action-prompt">Prompt</FieldLabel>
        <ModalTextarea
          id="quick-action-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          className="h-28 min-h-28"
          placeholder="Prompt placed in the Assistant composer"
        />
      </div>
      <ToggleRow
        label="Request document upload"
        caption="Ask for source documents before launching this workflow."
        checked={documentUpload}
        onChange={onDocumentUploadChange}
      />
      {enabled !== undefined && onEnabledChange && (
        <ToggleRow
          label="Active"
          caption="Show this action in the Assistant initial view."
          checked={enabled}
          onChange={onEnabledChange}
        />
      )}
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  caption,
  checked,
  onChange,
}: {
  label: string;
  caption: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">{caption}</p>
      </div>
      <ToggleSwitchUI
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}
