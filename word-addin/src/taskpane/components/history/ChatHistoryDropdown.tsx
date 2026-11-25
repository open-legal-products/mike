import React, { useMemo, useState } from "react";
import { History } from "lucide-react";
import chatIcon from "@icons/features/chat.svg";
import { ChatHistoryDropdownUI } from "@mike/ui";
import { LiquidIconButton } from "../primitives/LiquidActionRow";
import { chatTitle, formatRelativeDate } from "./ChatHistoryList";
import { useOpenWordChat } from "../../hooks/useOpenWordChat";
import { usePaginatedChats } from "../../hooks/usePaginatedChats";
import type { WordChatStorageMode } from "../../lib/wordChatSettings";
import type { WordChatOpenHandler } from "../../lib/wordChatTypes";
import { useAddinWorkspace } from "../../lib/addinWorkspace";
import {
  historyEmptyLabel,
  workspaceStorageNotice,
} from "../../lib/workspaceState";

const PAGE_SIZE = 10;

interface ChatHistoryDropdownProps {
  onSelect: WordChatOpenHandler;
  documentId: string;
  storageMode: WordChatStorageMode;
  ownerId: string;
  /** The chat on screen, marked as the current row. */
  currentChatId?: string | null;
}

/**
 * The header's recent-chats menu. The menu itself is the web app's
 * (ChatHistoryDropdownUI); this feeds it the document's stored chats, a page
 * at a time, and opens the one that is picked.
 */
export function ChatHistoryDropdown({
  onSelect,
  documentId,
  ownerId,
  storageMode,
  currentChatId,
}: ChatHistoryDropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { workspaceId, organizations } = useAddinWorkspace();
  // The header is mounted with the Assistant page, so this preloads the first
  // ten rows before the user opens the dropdown.
  const { chats, loading, loadingMore, error, hasMore, loadMore, retry } =
    usePaginatedChats(
      PAGE_SIZE,
      true,
      documentId,
      ownerId,
      storageMode,
      workspaceId,
    );
  const { openChat, loadingChatId, openError, cancel } = useOpenWordChat(
    documentId,
    ownerId,
    storageMode,
    (chatId, messages, model, reasoningLevel, activeTurnId) => {
      setOpen(false);
      onSelect(chatId, messages, model, reasoningLevel, activeTurnId);
    },
  );

  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    return chats
      .filter((chat) => !query || chatTitle(chat).toLowerCase().includes(query))
      .map((chat) => ({
        id: chat.id,
        title: chatTitle(chat),
        current: chat.id === currentChatId,
        icon: (
          <img
            src={chatIcon}
            alt=""
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 object-contain"
          />
        ),
        time: {
          label: formatRelativeDate(chat.created_at),
          dateTime: chat.created_at,
        },
        pending: chat.id === loadingChatId,
      }));
  }, [chats, currentChatId, loadingChatId, search]);

  return (
    <ChatHistoryDropdownUI
      open={open}
      onOpenChange={(next) => {
        // A dismissed menu abandons the chat it was still loading, so that
        // response cannot replace whatever is picked next.
        if (!next) cancel();
        setOpen(next);
      }}
      trigger={
        <LiquidIconButton aria-label="Chat history" title="Chat history">
          <History
            data-testid="chat-history-trigger-icon"
            className="h-4 w-4"
          />
        </LiquidIconButton>
      }
      align="end"
      listProps={{ "data-testid": `chat-history-list-${PAGE_SIZE}` }}
      query={search}
      onQueryChange={setSearch}
      items={items}
      // The chat has to be fetched before it can be shown; the menu stays
      // open, with a spinner on the row, until it arrives.
      closeOnSelect={false}
      disabled={loadingChatId !== null}
      onSelect={(chatId) => void openChat(chatId)}
      loading={loading}
      error={error}
      onRetry={retry}
      notice={openError}
      emptyLabel={
        (!search &&
          workspaceStorageNotice(storageMode, workspaceId, organizations)) ||
        historyEmptyLabel(search, workspaceId, organizations)
      }
      onReachEnd={loadMore}
      loadingMore={loadingMore}
      footer={
        !hasMore && chats.length > PAGE_SIZE ? "All chats loaded" : undefined
      }
    />
  );
}
