import React, { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ToggleSwitchUI } from "@mike/toggle-switch-ui";
import {
  createQuickAction,
  listWorkflows,
  updateQuickAction,
} from "../../api/mikeApi";
import type { QuickAction, Workflow } from "../../types";
import {
  addQuickAction,
  replaceQuickAction,
  useQuickActions,
} from "../../lib/quickActionStore";
import {
  isWordQuickActionWorkflow,
  quickActionDisplayName,
} from "../../lib/quickActions";
import { Modal } from "../primitives/Modal";
import {
  ModalFieldLabel,
  ModalSelect,
  ModalTextArea,
  ModalTextInput,
} from "../primitives/ModalForm";
import { PageTitle } from "../primitives/PageTitle";

interface DocumentActionsProps {
  createOpen: boolean;
  onCreateClose: () => void;
}

export function DocumentActions({
  createOpen,
  onCreateClose,
}: DocumentActionsProps): React.ReactElement {
  const [search, setSearch] = useState("");
  const [selectedAction, setSelectedAction] = useState<QuickAction | null>(
    null,
  );
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const actions = useQuickActions();

  useEffect(() => {
    let cancelled = false;
    void listWorkflows("assistant")
      .then((rows) => {
        if (cancelled) return;
        setWorkflows(rows);
        setWorkflowsError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setWorkflowsError(
          reason instanceof Error
            ? reason.message
            : "Could not load assistant workflows.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!createOpen) return;
    setWorkflowId("");
    setName("");
    setPrompt("");
    setCreateError(null);
  }, [createOpen]);

  const availableWorkflows = useMemo(() => {
    const used = new Set(actions.map((action) => action.workflow_id));
    return workflows.filter(
      (workflow) =>
        !used.has(workflow.id) && isWordQuickActionWorkflow(workflow),
    );
  }, [actions, workflows]);
  const filteredActions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return actions;
    return actions.filter((action) =>
      `${quickActionDisplayName(action)} ${action.workflow.title}`
        .toLowerCase()
        .includes(query),
    );
  }, [actions, search]);
  const selectedHasChanges = useMemo(() => {
    if (!selectedAction) return false;
    const original = actions.find((action) => action.id === selectedAction.id);
    if (!original) return false;
    return (
      selectedAction.workflow_id !== original.workflow_id ||
      quickActionDisplayName(selectedAction) !==
        quickActionDisplayName(original) ||
      selectedAction.prompt !== original.prompt ||
      selectedAction.enabled !== original.enabled
    );
  }, [actions, selectedAction]);

  function openAction(action: QuickAction): void {
    setSaveError(null);
    setSelectedAction({ ...action, name: quickActionDisplayName(action) });
  }

  async function saveActionDetails(action: QuickAction): Promise<void> {
    if (!action.name?.trim() || !selectedHasChanges || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateQuickAction(action.id, {
        workflow_id: action.workflow_id,
        name: action.name.trim(),
        prompt: action.prompt,
        enabled: action.enabled,
      });
      replaceQuickAction(updated);
      setSelectedAction(null);
    } catch (reason) {
      setSaveError(
        reason instanceof Error
          ? reason.message
          : "Failed to save quick action",
      );
    } finally {
      setSaving(false);
    }
  }

  async function createAction(): Promise<void> {
    if (!workflowId || !name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createQuickAction({
        workflow_id: workflowId,
        name: name.trim(),
        prompt,
        document_upload: false,
        surface: "word",
        enabled: true,
        sort_order: actions.length,
      });
      addQuickAction(created);
      onCreateClose();
    } catch (reason) {
      setCreateError(
        reason instanceof Error
          ? reason.message
          : "Could not create quick action.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      data-testid="quick-actions-full-screen"
      className="flex h-full min-h-0 flex-col overflow-hidden p-3 @sm:p-4"
    >
      <PageTitle data-testid="quick-actions-page-title" className="mb-3 px-1">
        Quick Actions
      </PageTitle>

      <label className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 text-gray-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_7px_rgba(15,23,42,0.05)]">
        <Search className="h-3.5 w-3.5" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search quick actions..."
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400"
        />
      </label>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-sm pb-3">
        {filteredActions.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            No quick actions found.
          </p>
        ) : (
          <div className="space-y-px">
            {filteredActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => openAction(action)}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {quickActionDisplayName(action)}
                </span>
                <span
                  className={
                    action.enabled
                      ? "shrink-0 text-xs text-green-600"
                      : "shrink-0 text-xs text-gray-400"
                  }
                >
                  {action.enabled ? "Active" : "Inactive"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!selectedAction}
        onClose={() => {
          if (saving) return;
          setSelectedAction(null);
          setSaveError(null);
        }}
        parentLabel="Quick Actions"
        title={
          selectedAction
            ? quickActionDisplayName(selectedAction)
            : "Quick action"
        }
        primaryAction={{
          label: saving ? "Saving…" : "Save",
          disabled:
            saving || !selectedHasChanges || !selectedAction?.name?.trim(),
          onClick: () =>
            selectedAction && void saveActionDetails(selectedAction),
        }}
      >
        {selectedAction && (
          <QuickActionForm
            name={selectedAction.name ?? ""}
            workflowId={selectedAction.workflow_id}
            workflowOptions={[
              {
                value: selectedAction.workflow_id,
                label: selectedAction.workflow.title,
              },
              ...availableWorkflows.map((workflow) => ({
                value: workflow.id,
                label: workflow.metadata.title,
              })),
            ]}
            prompt={selectedAction.prompt}
            enabled={selectedAction.enabled}
            onNameChange={(value) =>
              setSelectedAction({ ...selectedAction, name: value })
            }
            onWorkflowChange={(value) => {
              const workflow = workflows.find((item) => item.id === value);
              if (!workflow) return;
              setSelectedAction({
                ...selectedAction,
                workflow_id: workflow.id,
                workflow: {
                  id: workflow.id,
                  title: workflow.metadata.title,
                },
              });
            }}
            onPromptChange={(value) =>
              setSelectedAction({ ...selectedAction, prompt: value })
            }
            onEnabledChange={(value) =>
              setSelectedAction({ ...selectedAction, enabled: value })
            }
            error={saveError}
          />
        )}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => {
          if (!creating) onCreateClose();
        }}
        parentLabel="Quick Actions"
        title="New Quick Action"
        primaryAction={{
          label: creating ? "Creating…" : "Create",
          disabled: creating || !workflowId || !name.trim(),
          onClick: () => void createAction(),
        }}
      >
        <QuickActionForm
          name={name}
          workflowId={workflowId}
          workflowOptions={availableWorkflows.map((workflow) => ({
            value: workflow.id,
            label: workflow.metadata.title,
          }))}
          prompt={prompt}
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
          error={createError ?? workflowsError}
        />
      </Modal>
    </div>
  );
}

function QuickActionForm({
  name,
  workflowId,
  workflowOptions,
  prompt,
  enabled,
  onNameChange,
  onWorkflowChange,
  onPromptChange,
  onEnabledChange,
  error,
}: {
  name: string;
  workflowId: string;
  workflowOptions: { value: string; label: string }[];
  prompt: string;
  enabled?: boolean;
  onNameChange: (value: string) => void;
  onWorkflowChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onEnabledChange?: (value: boolean) => void;
  error: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-5">
      <div>
        <ModalFieldLabel htmlFor="quick-action-name">Name</ModalFieldLabel>
        <ModalTextInput
          id="quick-action-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Quick action name"
          variant="minimal"
          autoFocus
        />
      </div>
      <div>
        <ModalFieldLabel htmlFor="quick-action-workflow">
          Workflow used
        </ModalFieldLabel>
        <ModalSelect
          id="quick-action-workflow"
          value={workflowId}
          placeholder="Select an assistant workflow"
          options={workflowOptions}
          onChange={onWorkflowChange}
        />
      </div>
      <div>
        <ModalFieldLabel htmlFor="quick-action-prompt">Prompt</ModalFieldLabel>
        <ModalTextArea
          id="quick-action-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          className="h-28 min-h-28"
          placeholder="Prompt placed in the Assistant composer"
        />
      </div>
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
