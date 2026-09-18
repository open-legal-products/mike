import { useCallback, useEffect, useRef, useState } from "react";
import type { Chat } from "../types";
import { listCloudWordChats } from "../api/mikeApi";
import { listLocalWordChats } from "../lib/localWordChats";
import type { WordChatStorageMode } from "../lib/wordChatSettings";
import { WORD_CHAT_HISTORY_CHANGED } from "../lib/wordChatHistoryEvents";
import { userMessage } from "../lib/notify";

export interface PaginatedChatsState {
  chats: Chat[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

const HISTORY_REQUEST_TIMEOUT_MS = 15_000;

export function usePaginatedChats(
  pageSize: number,
  active: boolean,
  documentId: string,
  ownerId: string,
  storageMode: WordChatStorageMode,
): PaginatedChatsState {
  const [offset, setOffset] = useState(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  // Monotonic fetch trigger: loadMore() bumps this so the fetch effect re-runs
  // even when the numeric offset is unchanged (which happens when a whole page
  // was deduped away because offset pagination shifted under us).
  const [requestId, setRequestId] = useState(0);
  const requestPendingRef = useRef(false);
  const loadedScopeRef = useRef("");

  useEffect(() => {
    const refresh = (): void => setRevision((current) => current + 1);
    window.addEventListener(WORD_CHAT_HISTORY_CHANGED, refresh);
    return () => window.removeEventListener(WORD_CHAT_HISTORY_CHANGED, refresh);
  }, []);

  useEffect(() => {
    if (!active) return;
    const scope = JSON.stringify([
      documentId,
      ownerId,
      pageSize,
      revision,
      storageMode,
    ]);
    if (loadedScopeRef.current !== scope) {
      loadedScopeRef.current = scope;
      // Clear stale rows BEFORE any early return so a scope switch never
      // leaves the previous document's chats on screen while offset resets.
      setChats([]);
      setHasMore(false);
      if (offset !== 0) {
        setOffset(0);
        return;
      }
    }
    let cancelled = false;
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: number | null = null;
    requestPendingRef.current = true;
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    const request =
      storageMode === "cloud"
        ? listCloudWordChats(
            documentId,
            pageSize + 1,
            offset,
            controller.signal,
          )
        : listLocalWordChats(documentId, ownerId, pageSize + 1, offset);
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("Chat history took too long to load."));
      }, HISTORY_REQUEST_TIMEOUT_MS);
    });
    void Promise.race([request, timeout])
      .then((items) => {
        if (cancelled) return;
        const next = items ?? [];
        const page = next.slice(0, pageSize);
        setChats((current) => {
          if (offset === 0) return page;
          const known = new Set(current.map((chat) => chat.id));
          return [...current, ...page.filter((chat) => !known.has(chat.id))];
        });
        setHasMore(next.length > pageSize);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          timedOut
            ? "Chat history took too long to load."
            : userMessage(reason, {
                fallback: "Mike couldn't load your chat history. Try again.",
              }),
        );
      })
      .finally(() => {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        if (cancelled) return;
        requestPendingRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      });

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [active, documentId, offset, ownerId, pageSize, requestId, revision, storageMode]);

  const loadMore = useCallback((): void => {
    if (!active || !hasMore || requestPendingRef.current) return;
    requestPendingRef.current = true;
    setLoadingMore(true);
    // requestId guarantees a fetch even when chats.length equals the current
    // offset (every row of the last page was a dedupe hit), where an
    // offset-only effect key would never re-run and the spinner plus
    // requestPendingRef would deadlock all further pagination.
    setRequestId((current) => current + 1);
    setOffset(chats.length);
  }, [active, chats.length, hasMore]);

  const retry = useCallback((): void => {
    setRevision((current) => current + 1);
  }, []);

  return {
    chats,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  };
}
