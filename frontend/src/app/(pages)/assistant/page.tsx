"use client";

import { useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "@/app/components/assistant/ChatView";
import type { Message } from "@/app/components/shared/types";

export default function AssistantPage() {
    const router = useRouter();
    const {
        messages,
        isResponseLoading,
        handleChat,
        handleNewChat,
        cancel,
        chatId,
    } = useAssistantChat();

    async function handleInitialSubmit(message: Message) {
        const chatId = await handleNewChat(message);
        if (chatId) router.push(`/assistant/chat/${chatId}`);
    }

    return (
        <ChatView
            chatId={chatId}
            onInitialSubmit={
                messages.length === 0
                    ? (message) => void handleInitialSubmit(message)
                    : undefined
            }
            chatModel={messages[0]?.model ?? null}
            chatReasoningLevel={messages[0]?.reasoning ?? null}
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
        />
    );
}
