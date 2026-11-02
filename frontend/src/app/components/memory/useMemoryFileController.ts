"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MikeApiError, type MemoryCurrent } from "@/app/lib/mikeApi";
import { notifyError, userFacingApiError } from "@/app/lib/userFacingError";
import { useMemoryAutosave } from "./useMemoryAutosave";

const POLL_MIN_MS = 3000;
const POLL_MAX_MS = 30000;

/** True when a poll brought back nothing the UI has not already rendered. */
function sameMemory(a: MemoryCurrent | null, b: MemoryCurrent): boolean {
  return (
    !!a &&
    a.enabled === b.enabled &&
    a.revision === b.revision &&
    a.hash === b.hash &&
    a.status === b.status &&
    a.status_updated_at === b.status_updated_at &&
    a.content === b.content
  );
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

type Options = {
  active?: boolean;
  canEdit: boolean;
  mutationBlocked: boolean;
  pollBlocked?: boolean;
  flushOnUnmount: boolean;
  loadMemory: (signal?: AbortSignal) => Promise<MemoryCurrent>;
  saveMemory: (content: string, revision: number) => Promise<MemoryCurrent>;
  conflictLoadError: string;
  saveError: string;
  /** Shown when a save is refused because memory was turned off meanwhile. */
  disabledError: string;
  onCurrentChange?: (current: MemoryCurrent) => void;
};

/** Shared loading, polling, conflict, and autosave state for memory.md editors. */
export function useMemoryFileController({
  active = true,
  canEdit,
  mutationBlocked,
  pollBlocked = false,
  flushOnUnmount,
  loadMemory,
  saveMemory,
  conflictLoadError,
  saveError,
  disabledError,
  onCurrentChange,
}: Options) {
  const [memory, setMemory] = useState<MemoryCurrent | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  // How many consecutive polls came back unchanged; drives the backoff.
  const [quietPolls, setQuietPolls] = useState(0);
  const [visible, setVisible] = useState(documentVisible);
  const memoryRef = useRef<MemoryCurrent | null>(null);
  const onCurrentChangeRef = useRef(onCurrentChange);
  memoryRef.current = memory;
  onCurrentChangeRef.current = onCurrentChange;

  const syncCurrent = useCallback(
    (current: MemoryCurrent, syncDraft = true) => {
      memoryRef.current = current;
      setMemory(current);
      if (syncDraft) setDraft(current.content);
      onCurrentChangeRef.current?.(current);
    },
    [],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(false);
      try {
        const current = await loadMemory(signal);
        if (signal?.aborted) return;
        syncCurrent(current);
        setConflict(null);
        setError(null);
        setAutosaveError(null);
      } catch {
        if (!signal?.aborted) setLoadError(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [loadMemory, syncCurrent],
  );

  useEffect(() => {
    if (!active) {
      setMemory(null);
      setDraft("");
      setLoading(true);
      setLoadError(false);
      setConflict(null);
      setError(null);
      setAutosaveError(null);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [active, load]);

  const resolveConflict = useCallback(
    async (cause: unknown) => {
      if (!(cause instanceof MikeApiError) || cause.status !== 409) {
        return false;
      }
      if (cause.code === "memory_disabled") {
        // Someone turned memory off underneath the editor. Adopt the server's
        // enabled state so the toggle stops lying, keep the draft out of the
        // save queue, and say plainly why the text was not kept.
        try {
          const latest = await loadMemory();
          syncCurrent(latest, false);
        } catch {
          // The message below still explains the failed save.
        }
        setAutosaveError(disabledError);
        return true;
      }
      if (cause.code !== "memory_revision_conflict") return false;
      try {
        const latest = await loadMemory();
        setConflict(latest);
        onCurrentChangeRef.current?.(latest);
      } catch {
        setError(conflictLoadError);
      }
      return true;
    },
    [conflictLoadError, disabledError, loadMemory, syncCurrent],
  );

  const autosave = useMemoryAutosave({
    value: draft,
    persistedValue: memory?.content ?? "",
    enabled:
      active &&
      canEdit &&
      !!memory?.enabled &&
      !loading &&
      !loadError &&
      !mutationBlocked &&
      !conflict,
    // A draft the user is still deciding about (conflict) or one the server
    // already refused must not be re-sent behind their back on navigation:
    // the flush would carry a stale revision and fail where nobody can see.
    flushOnUnmount: flushOnUnmount && !conflict && !autosaveError,
    save: async (value) => {
      const current = memoryRef.current;
      if (!current) throw new Error("Memory is unavailable");
      const saved = await saveMemory(value, current.revision);
      memoryRef.current = saved;
      return saved;
    },
    getPersistedValue: (current) => current.content,
    onSaved: (current, { isLatest }) => {
      syncCurrent(current, isLatest);
      setAutosaveError(null);
    },
    onError: async (cause) => {
      if (!(await resolveConflict(cause))) {
        setAutosaveError(userFacingApiError(cause, saveError));
      }
    },
  });

  const dirty = !!memory && draft !== memory.content;

  // A hidden tab has nobody to show the status to. Pause the poll and run
  // one immediately when the tab comes back.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      setVisible(documentVisible());
      if (documentVisible()) setQuietPolls(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const polling =
    active &&
    !!memory?.enabled &&
    (memory.status === "scheduled" || memory.status === "processing");

  useEffect(() => {
    if (
      !polling ||
      !visible ||
      dirty ||
      conflict ||
      mutationBlocked ||
      pollBlocked ||
      autosave.inFlight
    ) {
      return;
    }
    const controller = new AbortController();
    // Back off while nothing changes: a curator that is wedged in
    // "processing" must not turn every open editor into a 3 s request loop.
    const delay = Math.min(POLL_MIN_MS * 2 ** quietPolls, POLL_MAX_MS);
    const timer = window.setTimeout(() => {
      void loadMemory(controller.signal)
        .then((current) => {
          if (controller.signal.aborted) return;
          if (sameMemory(memoryRef.current, current)) {
            // Re-arm without a state change the editor would notice: a new
            // memory object would reset the caret and undo stack.
            setQuietPolls((count) => count + 1);
            return;
          }
          setQuietPolls(0);
          syncCurrent(current);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          // This poll is the only thing that re-arms itself, so a failure
          // ends the status refresh: the file would sit on "processing"
          // forever unless the user hears about it and can reload.
          notifyError(cause, {
            action: "check for memory updates",
            dedupeKey: "memory-file-poll",
            onRetry: () => void load(),
          });
        });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    autosave.inFlight,
    conflict,
    dirty,
    load,
    loadMemory,
    memory,
    mutationBlocked,
    pollBlocked,
    polling,
    quietPolls,
    syncCurrent,
    visible,
  ]);

  const changeDraft = useCallback((value: string) => {
    setDraft(value);
    setAutosaveError(null);
    setError(null);
  }, []);

  const reloadLatest = useCallback(() => {
    if (!conflict) return;
    syncCurrent(conflict);
    setConflict(null);
    setError(null);
    setAutosaveError(null);
    autosave.cancelPending();
  }, [autosave, conflict, syncCurrent]);

  const keepDraftAfterConflict = useCallback(() => {
    if (!conflict) return;
    syncCurrent(conflict, false);
    setConflict(null);
    setError(null);
    if (!conflict.enabled) {
      // The conflicting write was a disable. There is no file to save the
      // draft into, so retrying would fail silently; say so instead.
      setAutosaveError(disabledError);
      autosave.cancelPending();
      return;
    }
    setAutosaveError(null);
    autosave.retry();
  }, [autosave, conflict, disabledError, syncCurrent]);

  return {
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
  };
}
