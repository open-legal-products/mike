import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Message } from "../../types";
import { Spinner } from "../../../shared/ui/spinner";
import { getCloudWordChat } from "../../api/mikeApi";
import { getLocalWordChat } from "../../lib/localWordChats";
import type { WordChatStorageMode } from "../../lib/wordChatSettings";
import {
  usePaginatedChats,
  type PaginatedChatsState,
} from "../../hooks/usePaginatedChats";
import { cn } from "../../../shared/lib/utils";
import type { ReasoningLevel } from "../../lib/wordChatTypes";
import { userMessage } from "../../lib/notify";

interface ChatHistoryListProps {
  pageSize: number;
  active?: boolean;
  search?: string;
  onSelect: (
    chatId: string,
    messages: Message[],
    model: string | null,
    reasoningLevel: ReasoningLevel | null,
  ) => void;
  className?: string;
  titleClassName?: string;
  documentId: string;
  storageMode: WordChatStorageMode;
  ownerId: string;
}

interface ChatHistoryListViewProps
  extends Omit<ChatHistoryListProps, "pageSize" | "active"> {
  pageSize: number;
  pagination: PaginatedChatsState;
  dateStyle?: "calendar" | "relative";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatRelativeDate(value: string): string {
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}m`;
  return `${Math.floor(months / 12)}y`;
}

export function ChatHistoryList({
  pageSize,
  active = true,
  search = "",
  onSelect,
  className,
  titleClassName,
  documentId,
  ownerId,
  storageMode,
}: ChatHistoryListProps): React.ReactElement {
  const pagination = usePaginatedChats(
    pageSize,
    active,
    documentId,
    ownerId,
    storageMode,
  );

  return (
    <ChatHistoryListView
      pageSize={pageSize}
      pagination={pagination}
      search={search}
      onSelect={onSelect}
      className={className}
      titleClassName={titleClassName}
      documentId={documentId}
      ownerId={ownerId}
      storageMode={storageMode}
    />
  );
}

export function ChatHistoryListView({
  pageSize,
  pagination,
  search = "",
  onSelect,
  className,
  titleClassName,
  dateStyle = "calendar",
  documentId,
  ownerId,
  storageMode,
}: ChatHistoryListViewProps): React.ReactElement {
  const { chats, loading, loadingMore, error, hasMore, loadMore, retry } =
    pagination;
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const detailRequestGenerationRef = useRef(0);
  const detailContext = JSON.stringify([documentId, ownerId, storageMode]);
  const detailContextRef = useRef(detailContext);
  detailContextRef.current = detailContext;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    detailRequestGenerationRef.current += 1;
    setLoadingChatId(null);
    setOpenError(null);
  }, [detailContext]);

  const filteredChats = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return chats;
    return chats.filter((chat) =>
      (chat.title?.trim() || "Untitled chat").toLowerCase().includes(query),
    );
  }, [chats, search]);

  const openChat = async (chatId: string): Promise<void> => {
    if (loadingChatId) return;
    const requestGeneration = detailRequestGenerationRef.current + 1;
    detailRequestGenerationRef.current = requestGeneration;
    const requestContext = detailContext;
    const requestIsCurrent = (): boolean =>
      mountedRef.current &&
      detailRequestGenerationRef.current === requestGeneration &&
      detailContextRef.current === requestContext;

    setLoadingChatId(chatId);
    setOpenError(null);
    try {
      const detail =
        storageMode === "cloud"
          ? await getCloudWordChat(documentId, chatId)
          : await getLocalWordChat(documentId, ownerId, chatId);
      if (!requestIsCurrent()) return;
      onSelect(
        chatId,
        detail.messages,
        detail.chat.model ?? null,
        detail.chat.reasoning_level ?? null,
      );
    } catch (reason) {
      if (!requestIsCurrent()) return;
      setOpenError(
        userMessage(reason, {
          fallback: "Failed to open this chat.",
        }),
      );
    } finally {
      if (requestIsCurrent()) setLoadingChatId(null);
    }
  };

  return (
    <div
      data-testid={`chat-history-list-${pageSize}`}
      className={cn("min-h-0 overflow-y-auto", className)}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (
          element.scrollHeight - element.scrollTop - element.clientHeight <=
          24
        ) {
          loadMore();
        }
      }}
    >
      {openError && (
        <p role="alert" className="py-3 text-center text-xs text-destructive">
          {openError}
        </p>
      )}
      {error ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200"
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="flex min-h-32 items-center justify-center">
          <Spinner label="Loading chats…" />
        </div>
      ) : filteredChats.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">
          {search ? "No matches found" : "No chats saved for this document"}
        </p>
      ) : (
        <div className="space-y-px">
          {filteredChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => void openChat(chat.id)}
              disabled={loadingChatId !== null}
              className="flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left text-xs text-gray-700 transition-all hover:bg-gray-100 disabled:opacity-50"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  titleClassName,
                )}
              >
                {chat.title?.trim() || "Untitled chat"}
              </span>
              <span className="shrink-0 text-[10px] text-gray-400">
                {dateStyle === "relative"
                  ? formatRelativeDate(chat.created_at)
                  : formatDate(chat.created_at)}
              </span>
              {loadingChatId === chat.id && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
              )}
            </button>
          ))}
          {loadingMore && (
            <div className="flex justify-center py-3">
              <Spinner label="Loading more chats…" />
            </div>
          )}
          {!hasMore && chats.length > pageSize && (
            <p className="py-3 text-center text-[10px] text-gray-400">
              All chats loaded
            </p>
          )}
        </div>
      )}
    </div>
  );
}
