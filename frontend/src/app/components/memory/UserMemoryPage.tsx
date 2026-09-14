"use client";

import { useCallback, useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import {
  MemoryConflictNotice,
  MemorySaveStatus,
  memoryActivityLabel,
} from "@/app/components/memory/MemoryEditorState";
import { MemoryUpdateFailedPopup } from "@/app/components/memory/MemoryUpdateFailedPopup";
import { useMemoryFileController } from "@/app/components/memory/useMemoryFileController";
import {
  getUserMemory,
  setUserMemoryEnabled,
  updateUserMemory,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type ConfirmAction = "disable";

export function UserMemoryPage() {
  const [settingsMutation, setSettingsMutation] = useState<
    "enable" | "disable" | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const loadMemory = useCallback(
    (signal?: AbortSignal) => getUserMemory(signal),
    [],
  );
  const saveMemory = useCallback(
    (content: string, revision: number) => updateUserMemory(content, revision),
    [],
  );
  const {
    memory,
    draft,
    loading,
    loadError,
    conflict,
    error,
    autosaveError,
    dirty,
    autosave,
    load,
    syncCurrent,
    changeDraft,
    setError,
    setAutosaveError,
    reloadLatest,
    keepDraftAfterConflict,
  } = useMemoryFileController({
    canEdit: true,
    mutationBlocked: !!confirmAction || settingsMutation !== null,
    flushOnUnmount: settingsMutation === null,
    loadMemory,
    saveMemory,
    conflictLoadError:
      "Memory changed while you were editing. Reload the page before saving again.",
    saveError: "Memory could not be saved. Your draft has been kept.",
    disabledError:
      "Memory was turned off while you were editing, so your changes were not saved.",
  });

  const interactionLocked =
    autosave.inFlight || settingsMutation !== null || confirmAction !== null;
  const editorLocked = settingsMutation !== null || confirmAction !== null;

  async function enableMemory() {
    if (interactionLocked) return;
    setSettingsMutation("enable");
    setError(null);
    // A refusal from the disabled period ("your changes were not saved") is
    // over once memory is on again; leaving it up next to the fresh file
    // reads as if the new file were already failing.
    setAutosaveError(null);
    try {
      syncCurrent(await setUserMemoryEnabled(true));
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "App-wide memory could not be turned on. Please try again.",
        ),
      );
    } finally {
      setSettingsMutation(null);
    }
  }

  async function confirmSettingsMutation() {
    if (!confirmAction || settingsMutation || autosave.inFlight) return;
    setSettingsMutation("disable");
    setError(null);
    try {
      const current = await setUserMemoryEnabled(false);
      syncCurrent(current);
      setConfirmAction(null);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "App-wide memory could not be turned off. Please try again.",
        ),
      );
      setConfirmAction(null);
    } finally {
      setSettingsMutation(null);
    }
  }

  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby="app-memory-settings-heading"
      >
        <SettingsHeading id="app-memory-settings-heading">
          Memory
        </SettingsHeading>

        <SettingsCard>
          {loading ? (
            <div
              className="flex items-center justify-between gap-3 px-4 py-5"
              aria-label="Loading memory settings"
            >
              <div className="space-y-2">
                <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-72 max-w-full animate-pulse rounded bg-gray-100" />
              </div>
              <div className="h-5 w-9 animate-pulse rounded-full bg-gray-200" />
            </div>
          ) : loadError || !memory ? (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>Memory settings are unavailable</SettingsLabel>
                <p className="text-sm text-red-600" role="alert">
                  Could not load memory settings. Please try again.
                </p>
              </div>
              <PillButton tone="white" size="sm" onClick={() => void load()}>
                Retry
              </PillButton>
            </SettingsRow>
          ) : (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>App-wide memory</SettingsLabel>
                <SettingsDescription>
                  Let Mike curate useful details after saved conversations and
                  use them in future answers.
                </SettingsDescription>
              </div>
              <div className="flex items-center gap-3">
                <ToggleSwitch
                  checked={memory.enabled}
                  disabled={interactionLocked}
                  aria-busy={settingsMutation === "enable"}
                  aria-label="App-wide memory"
                  onCheckedChange={(enabled) => {
                    if (enabled) void enableMemory();
                    else {
                      autosave.cancelPending();
                      setConfirmAction("disable");
                    }
                  }}
                />
              </div>
            </SettingsRow>
          )}

          <ProjectMemoryDefaultRow />
        </SettingsCard>

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && memory && !memory.enabled && autosaveError ? (
          // The editor (and its status line) is gone once memory is off, but
          // the reason a draft was refused must still be visible.
          <p className="text-sm text-red-600" role="alert">
            {autosaveError}
          </p>
        ) : null}
      </section>

      {loading ? (
        <MemoryEditorSkeleton />
      ) : memory?.enabled ? (
        <section
          className="space-y-3"
          aria-labelledby="app-memory-file-heading"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <SettingsHeading id="app-memory-file-heading">
              Memory file
            </SettingsHeading>
            <div className="flex flex-wrap items-center gap-3">
              <MemorySaveStatus
                error={autosaveError}
                status={autosave.status}
                compact
                onRetry={() => {
                  setAutosaveError(null);
                  autosave.retry();
                }}
              />
              {memoryActivityLabel(memory) ? (
                <p className="text-xs text-gray-400" role="status">
                  {memoryActivityLabel(memory)}
                </p>
              ) : null}
            </div>
          </div>

          {conflict ? (
            <MemoryConflictNotice
              onReload={reloadLatest}
              onKeepDraft={keepDraftAfterConflict}
            />
          ) : null}

          <div className="min-h-[24rem]">
            <MarkdownEditor
              value={draft}
              onChange={(value) => {
                changeDraft(value);
              }}
              ariaLabel="App-wide memory"
              className="min-h-[24rem]"
              suspended={editorLocked}
              allowTables={false}
            />
          </div>
        </section>
      ) : null}

      <ConfirmPopup
        open={confirmAction !== null}
        title="Turn off and delete app-wide memory?"
        message={`This will delete the existing app-wide memory.md file${dirty ? " and your unsaved draft" : ""}, cancel pending memory updates, and stop future memory updates until you turn app-wide memory on again.`}
        confirmLabel="Disable"
        confirmVariant="danger"
        confirmStatus={settingsMutation ? "loading" : "idle"}
        onConfirm={() => void confirmSettingsMutation()}
        onCancel={() => {
          if (!settingsMutation) setConfirmAction(null);
        }}
      />
      <MemoryUpdateFailedPopup memory={memory} scopeKey="app" />
    </div>
  );
}

/**
 * The per-user default applied to projects this account creates. It is a
 * profile preference rather than a memory-file setting, so it stays usable
 * even when the memory file itself cannot be loaded, and it never overrides
 * another owner's choice on an existing project.
 */
function ProjectMemoryDefaultRow() {
  const { profile, updateProjectMemoryDefault } = useUserProfile();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProjectMemoryDefault(enabled);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "That preference could not be saved. Please try again.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow>
      <div className="space-y-1">
        <SettingsLabel>Project memory for new projects</SettingsLabel>
        <SettingsDescription>
          Choose whether memory is enabled by default for projects you create.
          Project owners can still change it for each project.
        </SettingsDescription>
        {error ? (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={profile?.projectMemoryDefault !== false}
        disabled={!profile || saving}
        aria-busy={saving}
        aria-label="Project memory for new projects"
        onCheckedChange={(enabled) => void handleToggle(enabled)}
      />
    </SettingsRow>
  );
}

function MemoryEditorSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading memory editor">
      <div className="space-y-2">
        <div className="h-7 w-36 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-96 animate-pulse rounded-2xl bg-app-surface" />
    </div>
  );
}
