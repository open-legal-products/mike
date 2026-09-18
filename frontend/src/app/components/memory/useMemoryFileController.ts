"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MikeApiError, type MemoryCurrent } from "@/app/lib/mikeApi";
import { notifyError, userFacingApiError } from "@/app/lib/userFacingError";
import { useMemoryAutosave } from "./useMemoryAutosave";

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
  onCurrentChange,
}: Options) {
  const [memory, setMemory] = useState<MemoryCurrent | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState<MemoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
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
      if (
        !(cause instanceof MikeApiError) ||
        cause.status !== 409 ||
        cause.code !== "memory_revision_conflict"
      ) {
        return false;
      }
      try {
        const latest = await loadMemory();
        setConflict(latest);
        onCurrentChangeRef.current?.(latest);
      } catch {
        setError(conflictLoadError);
      }
      return true;
    },
    [conflictLoadError, loadMemory],
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
    flushOnUnmount,
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

  useEffect(() => {
    if (
      !active ||
      !memory?.enabled ||
      (memory.status !== "scheduled" && memory.status !== "processing") ||
      dirty ||
      conflict ||
      mutationBlocked ||
      pollBlocked ||
      autosave.inFlight
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadMemory(controller.signal)
        .then((current) => {
          if (!controller.signal.aborted) syncCurrent(current);
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
    }, 3000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    autosave.inFlight,
    conflict,
    dirty,
    load,
    loadMemory,
    memory,
    mutationBlocked,
    pollBlocked,
    syncCurrent,
  ]);

  const changeDraft = useCallback((value: string) => {
    setDraft(value);
    setAutosaveError(null);
    setError(null);
  }, []);

  const useLatestConflict = useCallback(() => {
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
    setAutosaveError(null);
    autosave.retry();
  }, [autosave, conflict, syncCurrent]);

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
    useLatestConflict,
    keepDraftAfterConflict,
  };
}
