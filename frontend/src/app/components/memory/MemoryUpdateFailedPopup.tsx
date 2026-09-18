"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import type { MemoryCurrent } from "@/app/lib/mikeApi";

const DISMISSAL_PREFIX = "mike:memory-update-failure-dismissed:";
const DISMISSAL_EVENT = "mike:memory-update-failure-dismissed";

function failureId(memory: MemoryCurrent | null): string | null {
  if (memory?.status !== "failed") return null;
  return [
    memory.revision,
    memory.status_updated_at ?? memory.updated_at ?? "unknown",
    memory.hash ?? "empty",
  ].join(":");
}

export function MemoryUpdateFailedPopup({
  memory,
  scopeKey,
}: {
  memory: MemoryCurrent | null;
  /** Stable per-file key, such as `app` or `project:<id>`. */
  scopeKey: string;
}) {
  const storageKey = `${DISMISSAL_PREFIX}${scopeKey}`;
  const currentFailureId = failureId(memory);
  const [sessionDismissedFailureId, setSessionDismissedFailureId] = useState<
    string | null
  >(null);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) onStoreChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(DISMISSAL_EVENT, onStoreChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(DISMISSAL_EVENT, onStoreChange);
      };
    },
    [storageKey],
  );
  const getSnapshot = useCallback(() => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, [storageKey]);
  const persistedDismissedFailureId = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => null,
  );

  function dismiss() {
    if (!currentFailureId) return;
    try {
      window.localStorage.setItem(storageKey, currentFailureId);
      window.dispatchEvent(new Event(DISMISSAL_EVENT));
    } catch {
      // Component state still dismisses the popup for this page visit.
    }
    setSessionDismissedFailureId(currentFailureId);
  }

  return (
    <WarningPopup
      open={
        currentFailureId !== null &&
        currentFailureId !== persistedDismissedFailureId &&
        currentFailureId !== sessionDismissedFailureId
      }
      onClose={dismiss}
      message="The latest automatic update failed. Existing memory is unchanged."
    />
  );
}
