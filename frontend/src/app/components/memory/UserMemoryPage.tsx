"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  History,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";
import { SettingsToggle } from "@/app/(pages)/settings/SettingsToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { GlassCard } from "@/app/components/ui/glass-card";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import {
  MikeApiError,
  downloadUserMemoryMarkdown,
  getUserMemory,
  listUserMemoryVersions,
  restoreUserMemoryVersion,
  setUserMemoryEnabled,
  updateUserMemory,
  wipeUserMemory,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type ConfirmAction = "disable" | "wipe";

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function versionSource(version: MemoryVersion) {
  if (version.source === "manual") return "Manual edit";
  if (version.source === "restore") return "Restored version";
  const surface =
    version.source_surface === "word"
      ? "Word"
      : version.source_surface === "tabular"
        ? "tabular review"
        : "chat";
  return `Automatic update after ${surface}`;
}

function currentStatus(memory: MemoryCurrent) {
  if (memory.status === "scheduled") return "Memory review scheduled";
  if (memory.status === "processing") return "Updating memory…";
  if (memory.status === "failed")
    return "The latest automatic update failed. Existing memory is unchanged.";
  if (!memory.updated_at) return "No saved memory yet";
  return `Last updated ${formatDate(memory.updated_at)}`;
}

function currentSource(source: MemoryCurrent["source"]) {
  if (source === "manual") return "Manual edit";
  if (source === "curator") return "Automatic update";
  if (source === "restore") return "Restored version";
  return null;
}

function enabledStatus(memory: MemoryCurrent) {
  if (!memory.enabled) return "Off";
  if (memory.status === "scheduled") return "On · review scheduled";
  if (memory.status === "processing") return "On · updating";
  if (memory.status === "failed") return "On · latest review failed";
  return "On";
}

export function UserMemoryPage() {
  const [memory, setMemory] = useState<MemoryCurrent | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreCandidate, setRestoreCandidate] =
    useState<MemoryVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [settingsMutation, setSettingsMutation] = useState<
    "enable" | "disable" | "wipe" | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const historyRequestRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(false);
    try {
      const current = await getUserMemory(signal);
      if (signal?.aborted) return;
      setMemory(current);
      setDraft(current.content);
      setConflict(null);
      setError(null);
    } catch {
      if (!signal?.aborted) {
        setLoadError(true);
        setLoading(false);
        setHistoryLoading(false);
      }
      return;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }

    const historyRequest = ++historyRequestRef.current;
    setHistoryLoading(true);
    try {
      const history = await listUserMemoryVersions(signal);
      if (signal?.aborted || historyRequest !== historyRequestRef.current)
        return;
      setVersions(history);
      setHistoryError(false);
    } catch {
      if (!signal?.aborted && historyRequest === historyRequestRef.current)
        setHistoryError(true);
    } finally {
      if (!signal?.aborted && historyRequest === historyRequestRef.current)
        setHistoryLoading(false);
    }
  }, []);

  const refreshVersions = useCallback(async () => {
    const historyRequest = ++historyRequestRef.current;
    try {
      const history = await listUserMemoryVersions();
      if (historyRequest !== historyRequestRef.current) return;
      setVersions(history);
      setHistoryError(false);
    } catch {
      if (historyRequest === historyRequestRef.current) setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty = !!memory && draft !== memory.content;
  const interactionLocked =
    saving ||
    restoring ||
    settingsMutation !== null ||
    confirmAction !== null ||
    restoreCandidate !== null;

  useEffect(() => {
    if (
      !memory?.enabled ||
      (memory.status !== "scheduled" && memory.status !== "processing") ||
      dirty ||
      conflict ||
      interactionLocked
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getUserMemory(controller.signal)
        .then((current) => {
          if (controller.signal.aborted) return;
          const versionChanged = current.version !== memory.version;
          setMemory(current);
          setDraft(current.content);
          if (versionChanged) void refreshVersions();
        })
        .catch(() => {
          // The current file remains usable; a later page load can
          // recover status if this non-critical refresh fails.
        });
    }, 3000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [conflict, dirty, interactionLocked, memory, refreshVersions]);

  async function resolveConflict(cause: unknown) {
    if (
      !(cause instanceof MikeApiError) ||
      cause.status !== 409 ||
      cause.code !== "memory_version_conflict"
    ) {
      return false;
    }
    try {
      setConflict(await getUserMemory());
    } catch {
      setError(
        "Memory changed while you were editing. Reload the page before saving again.",
      );
    }
    return true;
  }

  async function saveMemory() {
    if (
      !memory ||
      !memory.enabled ||
      !dirty ||
      saving ||
      restoring ||
      conflict ||
      confirmAction ||
      restoreCandidate ||
      settingsMutation
    )
      return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const current = await updateUserMemory(draft, memory.version);
      setMemory(current);
      setDraft(current.content);
      setSavedNotice("Memory saved");
      await refreshVersions();
    } catch (cause) {
      if (!(await resolveConflict(cause))) {
        setError(
          userFacingApiError(
            cause,
            "Memory could not be saved. Your draft has been kept.",
          ),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function restoreVersion() {
    if (
      !memory ||
      !restoreCandidate ||
      restoring ||
      saving ||
      conflict ||
      confirmAction ||
      settingsMutation
    )
      return;
    setRestoring(true);
    setError(null);
    setSavedNotice(null);
    try {
      const current = await restoreUserMemoryVersion(
        restoreCandidate.id,
        memory.version,
      );
      setMemory(current);
      setDraft(current.content);
      setRestoreCandidate(null);
      setSavedNotice(`Version ${restoreCandidate.version} restored`);
      await refreshVersions();
    } catch (cause) {
      setRestoreCandidate(null);
      if (!(await resolveConflict(cause))) {
        setError(
          userFacingApiError(
            cause,
            "That memory version could not be restored. Please try again.",
          ),
        );
      }
    } finally {
      setRestoring(false);
    }
  }

  async function downloadMemory() {
    if (!memory || memory.hash === null || downloading || interactionLocked)
      return;
    setDownloading(true);
    setError(null);
    try {
      const { blob, filename } = await downloadUserMemoryMarkdown();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "memory.md";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          "Memory could not be downloaded. Please try again.",
        ),
      );
    } finally {
      setDownloading(false);
    }
  }

  function useLatestConflict() {
    if (!conflict) return;
    setMemory(conflict);
    setDraft(conflict.content);
    setConflict(null);
    setError(null);
    void refreshVersions();
  }

  function keepDraftAfterConflict() {
    if (!conflict) return;
    setMemory(conflict);
    setConflict(null);
    setError(null);
    void refreshVersions();
  }

  function cancelDraft() {
    if (!memory) return;
    setDraft(memory.content);
    setConflict(null);
    setError(null);
    setSavedNotice(null);
  }

  function syncSettingsMutation(
    current: MemoryCurrent,
    notice: string,
  ) {
    historyRequestRef.current += 1;
    setMemory(current);
    setDraft(current.content);
    setVersions([]);
    setHistoryLoading(false);
    setHistoryError(false);
    setConflict(null);
    setRestoreCandidate(null);
    setError(null);
    setSavedNotice(notice);
  }

  async function enableMemory() {
    if (interactionLocked) return;
    setSettingsMutation("enable");
    setError(null);
    setSavedNotice(null);
    try {
      syncSettingsMutation(
        await setUserMemoryEnabled(true),
        "App-wide memory enabled",
      );
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
    if (
      !confirmAction ||
      settingsMutation ||
      saving ||
      restoring ||
      restoreCandidate
    )
      return;
    const action = confirmAction;
    setSettingsMutation(action);
    setError(null);
    setSavedNotice(null);
    try {
      const current =
        action === "disable"
          ? await setUserMemoryEnabled(false)
          : await wipeUserMemory();
      syncSettingsMutation(
        current,
        action === "disable"
          ? "App-wide memory turned off and deleted"
          : "Memory and version history deleted",
      );
      setConfirmAction(null);
    } catch (cause) {
      setError(
        userFacingApiError(
          cause,
          action === "disable"
            ? "App-wide memory could not be turned off. Please try again."
            : "App-wide memory could not be wiped. Please try again.",
        ),
      );
      setConfirmAction(null);
    } finally {
      setSettingsMutation(null);
    }
  }

  const confirmIsDisable = confirmAction === "disable";

  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby="app-memory-settings-heading"
      >
        <div className="space-y-1">
          <h2
            id="app-memory-settings-heading"
            className="font-serif text-2xl font-medium text-gray-900"
          >
            Memory
          </h2>
          <p className="text-sm text-gray-500">
            Control what Mike remembers across your conversations and edit the
            underlying Markdown file.
          </p>
        </div>

        <SettingsSection>
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
            <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-gray-700">
                  Memory settings are unavailable
                </p>
                <p className="text-sm text-red-600" role="alert">
                  Could not load memory settings. Please try again.
                </p>
              </div>
              <PillButton tone="white" size="sm" onClick={() => void load()}>
                Retry
              </PillButton>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-gray-700">
                    App-wide memory
                  </p>
                  <p className="max-w-xl text-sm text-gray-500">
                    Let Mike curate useful details after saved conversations and
                    use them in future answers.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="text-xs font-medium text-gray-500"
                    role="status"
                    aria-live="polite"
                  >
                    {enabledStatus(memory)}
                  </span>
                  <SettingsToggle
                    checked={memory.enabled}
                    loading={settingsMutation === "enable"}
                    disabled={interactionLocked}
                    size="md"
                    ariaLabel="App-wide memory"
                    onChange={(enabled) => {
                      if (enabled) void enableMemory();
                      else setConfirmAction("disable");
                    }}
                  />
                </div>
              </div>

              {memory.enabled ? (
                <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-gray-700">
                      Wipe memory
                    </p>
                    <p className="max-w-xl text-sm text-gray-500">
                      Delete the file and its history while keeping memory
                      turned on for future conversations.
                    </p>
                  </div>
                  <PillButton
                    tone="danger"
                    size="sm"
                    disabled={
                      interactionLocked ||
                      (memory.hash === null && memory.status === "idle")
                    }
                    onClick={() => setConfirmAction("wipe")}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    Wipe memory
                  </PillButton>
                </div>
              ) : null}
            </>
          )}
        </SettingsSection>

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : savedNotice ? (
          <p className="text-sm text-gray-500" role="status">
            {savedNotice}
          </p>
        ) : null}
      </section>

      {loading ? (
        <MemoryEditorSkeleton />
      ) : memory?.enabled ? (
        <>
          <section
            className="space-y-3"
            aria-labelledby="app-memory-file-heading"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <h2
                  id="app-memory-file-heading"
                  className="font-serif text-2xl font-medium text-gray-900"
                >
                  Memory file
                </h2>
                <p className="max-w-3xl text-sm text-gray-500">
                  Mike may curate this private Markdown file after saved
                  conversations. You can review and edit it at any time.
                </p>
                <p
                  className={
                    memory.status === "failed"
                      ? "pt-1 text-xs text-red-600"
                      : "pt-1 text-xs text-gray-400"
                  }
                  role={memory.status === "failed" ? "alert" : "status"}
                >
                  {currentStatus(memory)}
                  {memory.hash !== null ? ` · Version ${memory.version}` : ""}
                  {memory.hash !== null && currentSource(memory.source)
                    ? ` · ${currentSource(memory.source)}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PillButton
                  tone="white"
                  size="sm"
                  disabled={
                    memory.hash === null ||
                    downloading ||
                    interactionLocked
                  }
                  onClick={() => void downloadMemory()}
                >
                  {downloading ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {downloading ? "Downloading…" : "Download memory.md"}
                </PillButton>
                <PillButton
                  tone="white"
                  size="sm"
                  disabled={!dirty || interactionLocked}
                  onClick={cancelDraft}
                >
                  Cancel
                </PillButton>
                <PillButton
                  tone="black"
                  size="sm"
                  disabled={
                    !dirty || conflict !== null || interactionLocked
                  }
                  onClick={() => void saveMemory()}
                >
                  {saving ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Save aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {saving ? "Saving…" : "Save"}
                </PillButton>
              </div>
            </div>

            {conflict ? (
              <div
                className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
                role="alert"
              >
                <p className="font-medium">
                  Memory changed while you were editing
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  Reload the latest version or keep your draft and save it
                  against the new version.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <PillButton
                    tone="white"
                    size="sm"
                    onClick={useLatestConflict}
                  >
                    Reload latest
                  </PillButton>
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={keepDraftAfterConflict}
                  >
                    Keep my draft
                  </PillButton>
                </div>
              </div>
            ) : null}

            <div className="min-h-[24rem]">
              <MarkdownEditor
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setSavedNotice(null);
                }}
                ariaLabel="App-wide memory"
                className="min-h-[24rem]"
                readOnly={interactionLocked}
              />
            </div>
          </section>

          <MemoryVersionHistory
            versions={versions}
            currentVersion={memory.version}
            loading={historyLoading}
            disabled={
              conflict !== null || interactionLocked
            }
            error={historyError}
            onRetry={() => void refreshVersions()}
            onRestore={setRestoreCandidate}
          />
        </>
      ) : null}

      <ConfirmPopup
        open={confirmAction !== null}
        title={
          confirmIsDisable
            ? "Turn off and delete app-wide memory?"
            : "Wipe app-wide memory?"
        }
        message={
          confirmIsDisable
            ? `This permanently deletes memory.md, its version history${dirty ? ", and your unsaved draft" : ""}, and cancels pending memory updates. Memory will remain off until you turn it on again. This cannot be undone.`
            : `This permanently deletes memory.md, its version history${dirty ? ", and your unsaved draft" : ""}, and cancels pending memory updates. Memory stays on and can be rebuilt from future conversations. This cannot be undone.`
        }
        confirmLabel={confirmIsDisable ? "Disable" : "Wipe memory"}
        confirmVariant="danger"
        confirmStatus={settingsMutation ? "loading" : "idle"}
        onConfirm={() => void confirmSettingsMutation()}
        onCancel={() => {
          if (!settingsMutation) setConfirmAction(null);
        }}
      />

      <ConfirmPopup
        open={restoreCandidate !== null}
        title={
          restoreCandidate
            ? `Restore version ${restoreCandidate.version}?`
            : undefined
        }
        message={
          dirty
            ? "Restoring creates a new current version and discards your unsaved draft. Existing version history is retained."
            : "Restoring creates a new current version. Existing version history is retained."
        }
        confirmLabel="Restore"
        confirmStatus={restoring ? "loading" : "idle"}
        onConfirm={() => void restoreVersion()}
        onCancel={() => {
          if (!restoring) setRestoreCandidate(null);
        }}
      />
    </div>
  );
}

function MemoryVersionHistory({
  versions,
  currentVersion,
  loading,
  disabled,
  error,
  onRetry,
  onRestore,
}: {
  versions: MemoryVersion[];
  currentVersion: number;
  loading: boolean;
  disabled: boolean;
  error: boolean;
  onRetry: () => void;
  onRestore: (version: MemoryVersion) => void;
}) {
  return (
    <section className="space-y-3" aria-labelledby="memory-history-heading">
      <div className="flex items-center gap-2">
        <History aria-hidden="true" className="h-4 w-4 text-gray-500" />
        <h2
          id="memory-history-heading"
          className="font-serif text-2xl font-medium text-gray-900"
        >
          Version history
        </h2>
      </div>
      <GlassCard>
        {loading ? (
          <div
            className="space-y-3 px-4 py-5"
            aria-label="Loading memory version history"
          >
            <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-64 max-w-full animate-pulse rounded bg-gray-100" />
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-red-600" role="alert">
              Version history could not be refreshed.
            </p>
            <PillButton tone="white" size="sm" onClick={onRetry}>
              Retry
            </PillButton>
          </div>
        ) : versions.length === 0 ? (
          <p className="px-4 py-5 text-sm text-gray-500">
            Saved versions will appear here.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {versions.map((version) => {
              const isCurrent = version.version === currentVersion;
              return (
                <li
                  key={version.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-700">
                      Version {version.version}
                      {isCurrent ? " · Current" : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {versionSource(version)} ·{" "}
                      {formatDate(version.created_at)} ·{" "}
                      {formatBytes(version.size_bytes)}
                    </p>
                    {version.change_summary ? (
                      <p className="mt-1 text-xs text-gray-600">
                        {version.change_summary}
                      </p>
                    ) : null}
                  </div>
                  {!isCurrent ? (
                    <PillButton
                      tone="white"
                      size="sm"
                      disabled={disabled}
                      onClick={() => onRestore(version)}
                    >
                      <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                      Restore
                    </PillButton>
                  ) : (
                    <span className="text-xs text-gray-400">
                      Current version
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </GlassCard>
    </section>
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
