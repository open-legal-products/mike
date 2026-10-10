"use client";

import { useEffect, useState, type ReactElement } from "react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { buildChatHistoryItems } from "@/app/components/shared/ChatPanelHeader";
import { ChatHistoryDropdownUI } from "@/shared/ui/ChatHistoryDropdownUI";

/**
 * The assistant's chat history, as a menu on one of a chat's header buttons.
 * Choosing a chat loads it into that chat's place on the page.
 */
export function AssistantChatHistoryMenu({
    open,
    onOpenChange,
    trigger,
    currentChatId,
    hiddenChatId,
    onLoad,
    onCloseAutoFocus,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger: ReactElement;
    currentChatId: string;
    /** The chat shown in the other pane, which cannot be opened twice. */
    hiddenChatId?: string | null;
    onLoad: (chatId: string) => void;
    onCloseAutoFocus?: (event: Event) => void;
}) {
    const { chats, hasMoreChats, loadingMoreChats, loadMoreChats } =
        useChatHistoryContext();
    const [query, setQuery] = useState("");
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        if (!open) return;
        const interval = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, [open]);

    return (
        <ChatHistoryDropdownUI
            open={open}
            onOpenChange={(next) => {
                if (next) setNow(Date.now());
                else setQuery("");
                onOpenChange(next);
            }}
            trigger={trigger}
            align="end"
            onCloseAutoFocus={onCloseAutoFocus}
            query={query}
            onQueryChange={setQuery}
            loading={chats === null}
            emptyLabel={chats?.length ? "No matches." : "No chats yet."}
            items={buildChatHistoryItems({
                chats: chats ?? [],
                currentChatId,
                hiddenChatId,
                query,
                now,
            })}
            onSelect={(chatId) => {
                if (chatId !== currentChatId) onLoad(chatId);
            }}
            onReachEnd={
                hasMoreChats ? () => void loadMoreChats() : undefined
            }
            loadingMore={loadingMoreChats}
        />
    );
}
