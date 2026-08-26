import { useCallback, useEffect, useState } from "react";

export type WordChatStorageMode = "cloud" | "local";

/**
 * How model-proposed edits reach the document.
 *
 * - `approval`: validate and preview each edit before the user applies it.
 * - `direct`: apply each streamed edit immediately as a pending tracked
 *   change. Applied edits remain available for acceptance or rejection.
 */
export type WordEditApplyMode = "approval" | "direct";

const STORAGE_KEY = "mike_word_chat_storage_mode";
const APPLY_MODE_KEY = "mike_word_edit_apply_mode";

function storageKey(ownerId: string): string {
  return `${STORAGE_KEY}:${ownerId}`;
}

export function useWordChatStoragePreference(ownerId: string | null): {
  mode: WordChatStorageMode;
  loading: boolean;
  setMode: (mode: WordChatStorageMode) => Promise<void>;
} {
  const [mode, setModeState] = useState<WordChatStorageMode>("cloud");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerId) {
      setModeState("cloud");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void OfficeRuntime.storage
      .getItem(storageKey(ownerId))
      .then((stored) => {
        if (!cancelled && stored === "local") setModeState("local");
      })
      .catch(() => {
        // Fail closed. A failed read cannot tell an unset preference from a
        // stored "local" (never persist server-side), and only one of those
        // mistakes is recoverable: staying local keeps this chat on the
        // device, while defaulting to cloud would silently upload the chats of
        // a user who explicitly opted out.
        if (!cancelled) setModeState("local");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const setMode = useCallback(
    async (next: WordChatStorageMode) => {
      if (!ownerId) throw new Error("Sign in before changing chat storage.");
      await OfficeRuntime.storage.setItem(storageKey(ownerId), next);
      setModeState(next);
    },
    [ownerId],
  );

  return { mode, loading, setMode };
}

export function useWordEditApplyMode(): {
  mode: WordEditApplyMode;
  setMode: (mode: WordEditApplyMode) => void;
} {
  const [mode, setModeState] = useState<WordEditApplyMode>("approval");

  useEffect(() => {
    let cancelled = false;
    void OfficeRuntime.storage
      .getItem(APPLY_MODE_KEY)
      .then((stored) => {
        if (!cancelled && stored === "direct") setModeState("direct");
      })
      .catch(() => {
        // Approval is the safe default when preference storage is
        // unavailable or contains an unknown value.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: WordEditApplyMode) => {
    // The toggle must not lag on pane storage latency; persistence is
    // best-effort and the safe default covers a lost write.
    setModeState(next);
    void OfficeRuntime.storage.setItem(APPLY_MODE_KEY, next).catch(() => {});
  }, []);

  return { mode, setMode };
}
