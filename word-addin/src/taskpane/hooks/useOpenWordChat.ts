import { useCallback, useEffect, useRef, useState } from "react";
import { getCloudWordChat } from "../api/mikeApi";
import { getLocalWordChat } from "../lib/localWordChats";
import type { WordChatStorageMode } from "../lib/wordChatSettings";
import type { WordChatOpenHandler } from "../lib/wordChatTypes";

export interface OpenWordChatState {
  /** Loads a stored chat and hands it to `onSelect` once it has arrived. */
  openChat: (chatId: string) => Promise<void>;
  /** The chat being loaded, or null. Only one loads at a time. */
  loadingChatId: string | null;
  openError: string | null;
  /**
   * Abandons a load in flight, so its response cannot replace whatever the
   * reader picks next. A history surface calls this when it is dismissed.
   */
  cancel: () => void;
}

/**
 * Opening a chat from history: fetches its transcript from wherever this
 * document's chats are stored and reports it through `onSelect`. Shared by the
 * history page's list and the header dropdown so both open chats the same way.
 */
export function useOpenWordChat(
  documentId: string,
  ownerId: string,
  storageMode: WordChatStorageMode,
  onSelect: WordChatOpenHandler,
): OpenWordChatState {
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const context = JSON.stringify([documentId, ownerId, storageMode]);
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const cancel = useCallback((): void => {
    requestGenerationRef.current += 1;
    setLoadingChatId(null);
    setOpenError(null);
  }, []);

  useEffect(() => {
    cancel();
  }, [cancel, context]);

  const openChat = async (chatId: string): Promise<void> => {
    if (loadingChatId) return;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const requestContext = context;
    const requestIsCurrent = (): boolean =>
      mountedRef.current &&
      requestGenerationRef.current === requestGeneration &&
      contextRef.current === requestContext;

    setLoadingChatId(chatId);
    setOpenError(null);
    try {
      // A cloud chat is told by the server which turn is still generating; a
      // local one has nothing server-side to ask, so it carries the id the
      // pane recorded when the turn started. Either way the pane reattaches
      // instead of opening a transcript whose last answer is missing.
      const detail =
        storageMode === "cloud"
          ? await getCloudWordChat(documentId, chatId).then((loaded) => ({
              ...loaded,
              activeTurnId: loaded.activeTurn?.id ?? null,
            }))
          : await getLocalWordChat(documentId, ownerId, chatId).then(
              (loaded) => ({
                ...loaded,
                activeTurnId: loaded.chat.active_turn_id ?? null,
              }),
            );
      if (!requestIsCurrent()) return;
      onSelect(
        chatId,
        detail.messages,
        detail.chat.model ?? null,
        detail.chat.reasoning_level ?? null,
        detail.activeTurnId,
      );
    } catch (reason) {
      if (!requestIsCurrent()) return;
      setOpenError(
        reason instanceof Error ? reason.message : "Failed to open this chat.",
      );
    } finally {
      if (requestIsCurrent()) setLoadingChatId(null);
    }
  };

  return { openChat, loadingChatId, openError, cancel };
}
