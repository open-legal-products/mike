import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Workflow } from "../../types";
import { Spinner } from "../../../shared/ui/spinner";
import {
  listWorkflows,
  updateWorkflow,
} from "../../api/mikeApi";
import { WorkflowList } from "./WorkflowList";
import { PageTitle } from "../primitives/PageTitle";
import { WorkflowAssets } from "./WorkflowAssets";
import { notifyError, userMessage } from "../../lib/notify";

const WorkflowPromptEditor = lazy(() =>
  import("./WorkflowPromptEditor").then((module) => ({
    default: module.WorkflowPromptEditor,
  }))
);

function withoutLeadingTitle(markdown: string): string {
  const value = markdown.trimStart();
  const withoutHashHeading = value.replace(/^#\s+[^\r\n]*(?:\r?\n|$)/, "");
  if (withoutHashHeading !== value) return withoutHashHeading.trimStart();
  return value
    .replace(/^[^\r\n]+\r?\n={3,}(?:\r?\n|$)/, "")
    .trimStart();
}

interface WorkflowPickerProps {
  selectedWorkflow: Workflow | null;
  onSelectedWorkflowChange: (workflow: Workflow | null) => void;
}

export function WorkflowPicker({
  selectedWorkflow,
  onSelectedWorkflowChange,
}: WorkflowPickerProps): React.ReactElement {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Bumped by the "Retry" on the failure toast; the list has no button of
  // its own to hang a retry on.
  const [fetchAttempt, setFetchAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [promptMd, setPromptMd] = useState("");
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  // The latest not-yet-persisted edit, so navigating away can flush it
  // instead of silently discarding what the user typed.
  const pendingSaveRef = useRef<{
    workflowId: string;
    skillMd: string;
  } | null>(null);
  // The workflow the detail view is currently showing. In-flight saves
  // compare against this before touching state, so a response that lands
  // after a deselect or switch cannot navigate the user back.
  const selectedIdRef = useRef<string | null>(null);

  const flushPendingSave = (): void => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pending) return;
    // Fire-and-forget: the detail view is going away, so there is no
    // surface left to report progress or errors on — but the edit itself
    // must still reach the server.
    void updateWorkflow(pending.workflowId, {
      skill_md: pending.skillMd,
    }).catch(() => {
      // Deliberately silent: this is the flush of an unmounted editor's last
      // autosave. There is no longer a surface to report on, and the next
      // edit to this workflow saves the full text again.
    });
  };

  useEffect(() => {
    let cancelled = false;
    listWorkflows("assistant")
      .then((all) => {
        const data = (all ?? []).filter(
          (workflow) =>
            workflow.metadata.type === "assistant" &&
            (workflow.skill_md ?? "").trim()
        );
        if (!cancelled) setWorkflows(data);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setFetchError(
          userMessage(reason, {
            fallback: "Mike couldn't load your workflows. Try again.",
          })
        );
        notifyError(reason, {
          action: "load your workflows",
          dedupeKey: "workflow-list",
          page: "Workflows",
          onRetry: () => {
            setFetchLoading(true);
            setFetchError(null);
            setFetchAttempt((count) => count + 1);
          },
        });
      })
      .finally(() => {
        if (!cancelled) setFetchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAttempt]);

  useEffect(() => {
    if (!selectedWorkflow) return;
    setWorkflows((current) => {
      const exists = current.some(
        (workflow) => workflow.id === selectedWorkflow.id
      );
      if (!exists) return [selectedWorkflow, ...current];
      return current.map((workflow) =>
        workflow.id === selectedWorkflow.id ? selectedWorkflow : workflow
      );
    });
  }, [selectedWorkflow]);

  useEffect(() => {
    selectedIdRef.current = selectedWorkflow?.id ?? null;
    setPromptMd(
      selectedWorkflow
        ? withoutLeadingTitle(selectedWorkflow.skill_md ?? "")
        : ""
    );
    setSaveStatus("idle");
    setSaveError(null);
    return () => {
      // Runs on deselect, on switching workflows, and on unmount. A debounce
      // timer still pending here holds an edit the user typed; flushing it
      // (instead of just clearing the timer) keeps navigation from being a
      // silent data-loss path.
      flushPendingSave();
      if (statusResetTimerRef.current) {
        clearTimeout(statusResetTimerRef.current);
        statusResetTimerRef.current = null;
      }
      // Cleared synchronously before any newer selection re-sets it, so an
      // in-flight save that resolves after this point sees a mismatch and
      // stays silent.
      selectedIdRef.current = null;
    };
  }, [selectedWorkflow?.id]);

  const readOnly =
    !!selectedWorkflow &&
    (selectedWorkflow.is_system || selectedWorkflow.allow_edit === false);

  const handlePromptChange = (next: string): void => {
    if (!selectedWorkflow || readOnly) return;
    setPromptMd(next);
    setSaveStatus("saving");
    setSaveError(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (statusResetTimerRef.current) {
      // A stale "Saved → idle" reset must not stamp "idle" over the newer
      // "Saving…" status this edit just set.
      clearTimeout(statusResetTimerRef.current);
      statusResetTimerRef.current = null;
    }
    const workflowAtChange = selectedWorkflow;
    pendingSaveRef.current = { workflowId: workflowAtChange.id, skillMd: next };
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      void updateWorkflow(workflowAtChange.id, { skill_md: next })
        .then((updated) => {
          // Bail if the user deselected or switched workflows while the
          // request was in flight: onSelectedWorkflowChange feeds straight
          // into setWorkflowPageSelection in App, so resolving late would
          // re-open the detail view for a workflow the user already left.
          if (selectedIdRef.current !== workflowAtChange.id) return;
          onSelectedWorkflowChange({
            ...workflowAtChange,
            ...updated,
            metadata: {
              ...workflowAtChange.metadata,
              ...updated.metadata,
            },
            skill_md: updated.skill_md ?? next,
          });
          setSaveStatus("saved");
          statusResetTimerRef.current = setTimeout(() => {
            statusResetTimerRef.current = null;
            setSaveStatus("idle");
          }, 2000);
        })
        .catch((reason: unknown) => {
          if (selectedIdRef.current !== workflowAtChange.id) return;
          setSaveStatus("idle");
          setSaveError(
            userMessage(reason, {
              fallback:
                "Mike couldn't save these instructions. Try again.",
            })
          );
        });
    }, 800);
  };

  const openWorkflow = (workflow: Workflow): void => {
    // Populate the prompt before mounting the already-loaded editor. Waiting
    // for the selected-workflow effect leaves one render where a revisited
    // workflow can initialize Tiptap with an empty document.
    setPromptMd(withoutLeadingTitle(workflow.skill_md ?? ""));
    onSelectedWorkflowChange(workflow);
  };

  if (!selectedWorkflow) {
    return (
      <div
        data-testid="workflows-full-screen"
        className="flex h-full min-h-0 flex-col overflow-hidden p-3 @sm:p-4"
      >
        <PageTitle
          data-testid="workflows-page-title"
          className="mb-3 px-1"
        >
          Workflows
        </PageTitle>
        <WorkflowList
          workflows={workflows}
          search={search}
          onSearchChange={setSearch}
          onSelect={openWorkflow}
          loading={fetchLoading}
          error={fetchError}
          emptyMessage="No workflows found."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3 @sm:p-4">
      <div className="flex min-w-0 shrink-0 items-center gap-3 px-1">
        <PageTitle
          data-testid="workflow-detail-title"
          className="min-w-0 flex-1 truncate"
        >
          {selectedWorkflow.metadata.title}
        </PageTitle>
        <span
          aria-live="polite"
          className={`shrink-0 text-[11px] ${
            saveError ? "text-red-500" : "text-gray-400"
          }`}
        >
          {saveError ??
            (saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "saved"
                ? "Saved"
                : "")}
        </span>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <section
          data-testid="workflow-skill-content"
          className="min-h-0 flex-1"
        >
          <div
            data-testid="workflow-skill-body"
            className="h-full min-h-0 break-words font-sans text-sm leading-relaxed text-gray-700"
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner label="Loading editor…" />
                </div>
              }
            >
              <WorkflowPromptEditor
                value={promptMd}
                onChange={readOnly ? undefined : handlePromptChange}
                readOnly={readOnly}
              />
            </Suspense>
          </div>
        </section>
        <WorkflowAssets
          workflowId={selectedWorkflow.id}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
