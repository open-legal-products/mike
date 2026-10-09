import React, { useState } from "react";
import { Search } from "lucide-react";
import { ChatHistoryList } from "./ChatHistoryList";
import { PageTitle } from "../primitives/PageTitle";
import type { WordChatStorageMode } from "../../lib/wordChatSettings";
import type { WordChatOpenHandler } from "../../lib/wordChatTypes";

interface ChatHistoryPageProps {
  onSelect: WordChatOpenHandler;
  documentId: string;
  storageMode: WordChatStorageMode;
  ownerId: string;
}

export function ChatHistoryPage({
  onSelect,
  documentId,
  ownerId,
  storageMode,
}: ChatHistoryPageProps): React.ReactElement {
  const [search, setSearch] = useState("");

  return (
    <div
      data-testid="chat-history-full-screen"
      className="flex h-full min-h-0 flex-col overflow-hidden p-3 @sm:p-4"
    >
      <PageTitle data-testid="chat-history-page-title" className="mb-3 px-1">
        Chat History
      </PageTitle>
      <label className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 text-gray-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_7px_rgba(15,23,42,0.05)]">
        <Search className="h-3.5 w-3.5" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chat history..."
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400"
        />
      </label>
      <ChatHistoryList
        pageSize={20}
        search={search}
        onSelect={onSelect}
        className="mt-2 flex-1 rounded-sm pb-3"
        documentId={documentId}
        ownerId={ownerId}
        storageMode={storageMode}
      />
    </div>
  );
}
