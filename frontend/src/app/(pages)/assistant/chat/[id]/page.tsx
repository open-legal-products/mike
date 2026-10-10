"use client";

import { useEffect, useRef, useState } from "react";
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
    const { setSideChatId } = useChatHistoryContext();
    useEffect(() => {
        setSideChatId(sideChatId || null);
        return () => setSideChatId(null);
    }, [sideChatId, setSideChatId]);
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
        <div ref={chatsRef} className="h-full w-full flex relative">
            <AssistantChatPane
                widthShare={hasSideChat ? 1 - sideChatShare : undefined}
                chatId={chatId}
                openChat={openChat}
                adoptChat={adoptChat}
                claimCreated={claimCreated}
                documentPanel={documentPanel}
                otherChatId={sideChatId}
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
                />
            )}
            <AssistantDocumentPanelHost panel={documentPanel} />
        </div>
    );
}
