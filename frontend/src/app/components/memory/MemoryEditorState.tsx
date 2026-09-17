"use client";

import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { MemoryAutosaveStatus } from "./useMemoryAutosave";
import type { MemoryCurrent } from "@/app/lib/mikeApi";

export function memoryActivityLabel(memory: MemoryCurrent) {
  if (memory.status === "scheduled") return "Memory review scheduled";
  if (memory.status === "processing") return "Updating memory…";
  return null;
}

export function MemoryConflictNotice({
  project = false,
  onReload,
  onKeepDraft,
}: {
  project?: boolean;
  onReload: () => void;
  onKeepDraft: () => void;
}) {
  return (
    <div
      className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="alert"
    >
      <p className="font-medium">
        {project ? "Project memory" : "Memory"} changed while you were editing
      </p>
      <p className="mt-1 text-xs text-amber-800">
        Reload what is saved now, or keep your draft and let it save over the
        change.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <PillButtonUI tone="white" size="sm" onClick={onReload}>
          Reload latest
        </PillButtonUI>
        <PillButtonUI tone="black" size="sm" onClick={onKeepDraft}>
          Keep my draft
        </PillButtonUI>
      </div>
    </div>
  );
}

export function MemorySaveStatus({
  error,
  status,
  onRetry,
  compact = false,
}: {
  error: string | null;
  status: MemoryAutosaveStatus;
  onRetry: () => void;
  compact?: boolean;
}) {
  if (error) {
    return (
      <span
        className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}
      >
        <span className="text-red-600" role="alert">
          {error}
        </span>
        <button
          type="button"
          className="font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          onClick={onRetry}
        >
          Retry
        </button>
      </span>
    );
  }
  if (status === "idle") return null;
  return (
    <span className="text-xs text-gray-500" role="status" aria-live="polite">
      {status === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}
