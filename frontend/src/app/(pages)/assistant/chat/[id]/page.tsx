"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageExcerpt } from "@/shared/lib/messageExcerpts";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useChatRoute } from "@/app/hooks/useChatRoute";
import { AssistantChatPane } from "@/app/components/assistant/AssistantChatPane";
import {
    AssistantChatDivider,
    resizedSideChatShare,
} from "@/app/components/assistant/AssistantChatDivider";
import { AssistantDocumentPanelHost } from "@/app/components/assistant/AssistantDocumentPanelHost";
import { useAssistantDocumentPanel } from "@/app/components/assistant/useAssistantDocumentPanel";

// Serves `/assistant` (a new chat) as well as `/assistant/chat/:id`: the
// first answer adopts its chat id in place, so it streams without a remount.
// A second chat can sit beside the first (`?side=`); both open their
// documents in the one side panel.

export default function AssistantChatPage() {
    const {
        chatId,
        openChat,
        adoptChat,
        claimCreated,
        sideChatId,
        openSideChat,
        adoptSideChat,
        closeSideChat,
    } = useChatRoute("/assistant/chat", "/assistant");
    const documentPanel = useAssistantDocumentPanel();
    // The sidebar treats a chat on screen as read, in either place.
    const { setSideChatId, sideChatRequest, requestSideChat } =
        useChatHistoryContext();
    // "Open in side chat" on a sidebar row.
    useEffect(() => {
        if (!sideChatRequest) return;
        requestSideChat(null);
        openSideChat(sideChatRequest);
    }, [sideChatRequest, requestSideChat, openSideChat]);
    useEffect(() => {
        setSideChatId(sideChatId || null);
        return () => setSideChatId(null);
    }, [sideChatId, setSideChatId]);
    // A passage the reader asked about in the side chat, held until that
    // chat's composer is on the page (opening the side chat if need be).
    const [sideChatExcerpt, setSideChatExcerpt] = useState<{
        id: number;
        excerpt: MessageExcerpt;
    } | null>(null);
    const clearSideChatExcerpt = useCallback(
        () => setSideChatExcerpt(null),
        [],
    );
    function askInSideChat(excerpt: MessageExcerpt) {
        if (sideChatId === null) openSideChat("");
        setSideChatExcerpt((current) => ({
            id: (current?.id ?? 0) + 1,
            excerpt,
        }));
    }
    const chatsRef = useRef<HTMLDivElement>(null);
    const [sideChatShare, setSideChatShare] = useState(0.5);
    const hasSideChat = sideChatId !== null;

    function resizeChats(dx: number) {
        const pane = (id: string) =>
            chatsRef.current?.querySelector<HTMLElement>(
                `[data-chat-pane="${id}"]`,
            );
        const primary = pane("primary");
        const side = pane("side");
        if (!primary || !side) return;
        setSideChatShare(
            resizedSideChatShare(primary.offsetWidth, side.offsetWidth, dx),
        );
    }

    return (
        // The side panel slides in from past the right edge. Clipped here, that
        // overhang is not something the page can be scrolled to: focusing or
        // revealing anything in the panel mid-slide would otherwise drag the
        // chats sideways, under the app sidebar.
        <div
            ref={chatsRef}
            className="relative flex h-full w-full overflow-x-clip"
        >
            <AssistantChatPane
                widthShare={hasSideChat ? 1 - sideChatShare : undefined}
                chatId={chatId}
                openChat={openChat}
                adoptChat={adoptChat}
                claimCreated={claimCreated}
                documentPanel={documentPanel}
                otherChatId={sideChatId}
                onAskInSideChat={askInSideChat}
                onOpenSideChat={
                    sideChatId === null ? () => openSideChat("") : undefined
                }
            />
            {hasSideChat && <AssistantChatDivider onResize={resizeChats} />}
            {sideChatId !== null && (
                <AssistantChatPane
                    widthShare={sideChatShare}
                    chatId={sideChatId}
                    openChat={openSideChat}
                    adoptChat={adoptSideChat}
                    claimCreated={claimCreated}
                    documentPanel={documentPanel}
                    otherChatId={chatId}
                    sideChat={{ onClose: closeSideChat }}
                    incomingExcerpt={sideChatExcerpt}
                    onIncomingExcerptAdded={clearSideChatExcerpt}
                />
            )}
            <AssistantDocumentPanelHost panel={documentPanel} />
        </div>
    );
}
