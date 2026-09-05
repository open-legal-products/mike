"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  Download,
  History,
  Loader2,
  RotateCcw,
  Save,
  Settings,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { GlassCard } from "@/app/components/ui/glass-card";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import {
  MikeApiError,
  downloadUserMemoryMarkdown,
  getUserMemory,
  listUserMemoryVersions,
  restoreUserMemoryVersion,
  updateUserMemory,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

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

export function UserMemoryPage() {
  const router = useRouter();
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

    setHistoryLoading(true);
    try {
      const history = await listUserMemoryVersions(signal);
      if (signal?.aborted) return;
      setVersions(history);
      setHistoryError(false);
    } catch {
      if (!signal?.aborted) setHistoryError(true);
    } finally {
      if (!signal?.aborted) setHistoryLoading(false);
    }
  }, []);

  const refreshVersions = useCallback(async () => {
    try {
      setVersions(await listUserMemoryVersions());
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty = !!memory && draft !== memory.content;

  useEffect(() => {
    if (
      !memory?.enabled ||
      (memory.status !== "scheduled" && memory.status !== "processing") ||
      dirty ||
      conflict
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
  }, [conflict, dirty, memory, refreshVersions]);

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
    if (!memory || !memory.enabled || !dirty || saving || conflict) return;
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
    if (!memory || !restoreCandidate || restoring || conflict) return;
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
    if (!memory || memory.hash === null || downloading) return;
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

  const pageActions = [
    {
      icon: <Settings aria-hidden="true" className="h-4 w-4" />,
      label: "Settings",
      title: "Settings",
      onClick: () => router.push("/settings/features#memory"),
    },
    {
      icon: downloading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        <Download aria-hidden="true" className="h-4 w-4" />
      ),
      label: downloading ? "Downloading…" : "Download memory.md",
      title: downloading ? "Downloading…" : "Download memory.md",
      disabled: !memory?.enabled || memory.hash === null || downloading,
      onClick: () => void downloadMemory(),
    },
    {
      label: "Cancel",
      title: "Cancel",
      disabled: !dirty || saving,
      onClick: cancelDraft,
    },
    {
      icon: saving ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      ) : (
        <Save aria-hidden="true" className="h-4 w-4" />
      ),
      label: saving ? "Saving…" : "Save",
      title: saving ? "Saving…" : "Save",
      disabled: !memory?.enabled || !dirty || saving || conflict !== null,
      onClick: () => void saveMemory(),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader actions={pageActions} loading={loading} shrink>
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Memory
        </h1>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          {loading ? (
            <MemoryPageSkeleton />
          ) : loadError || !memory ? (
            <GlassCard>
              <EmptyState
                icon={<Brain />}
                title="Memory could not be loaded"
                description="Try again to inspect or edit your app-wide memory."
                tone="error"
                className="px-5 py-8"
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => void load()}
                  >
                    Retry
                  </PillButton>
                }
              />
            </GlassCard>
          ) : !memory.enabled ? (
            <GlassCard>
              <EmptyState
                icon={<Brain />}
                title="App-wide memory is off"
                description="Turning memory off deletes its Markdown file and history. You can start again from Memory settings."
                className="px-5 py-8"
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => router.push("/settings/features#memory")}
                  >
                    Open settings
                  </PillButton>
                }
              />
            </GlassCard>
          ) : (
            <>
              <GlassCard>
                <div className="space-y-1 px-4 py-4">
                  <p className="text-sm font-medium text-gray-700">
                    Your private app-wide memory
                  </p>
                  <p className="max-w-3xl text-sm text-gray-500">
                    Mike may curate this Markdown file after saved
                    conversations. It can influence future answers, and changes
                    may appear after a short delay. You can review and edit it
                    at any time.
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
              </GlassCard>

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

              {error ? (
                <p className="text-sm text-red-600" role="alert">
                  {error}
                </p>
              ) : savedNotice ? (
                <p className="text-sm text-gray-500" role="status">
                  {savedNotice}
                </p>
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
                />
              </div>

              <MemoryVersionHistory
                versions={versions}
                currentVersion={memory.version}
                loading={historyLoading}
                disabled={restoring || conflict !== null}
                error={historyError}
                onRetry={() => void refreshVersions()}
                onRestore={setRestoreCandidate}
              />
            </>
          )}
        </div>
      </div>

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

function MemoryPageSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading memory">
      <GlassCard>
        <div className="space-y-2 px-4 py-5">
          <div className="h-4 w-48 animate-pulse rounded bg-gray-200" />
          <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
          <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
        </div>
      </GlassCard>
      <div className="h-96 animate-pulse rounded-2xl bg-app-surface" />
    </div>
  );
}
