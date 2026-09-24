"use client";

import { useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "@/app/components/assistant/ChatView";
import type { Message } from "@/app/components/shared/types";

export default function AssistantPage() {
    const router = useRouter();
    const {
        messages,
        rejectedApiKey,
        dismissInvalidApiKey,
        isResponseLoading,
        handleChat,
        handleNewChat,
        cancel,
        detach,
        chatId,
    } = useAssistantChat();

    async function handleInitialSubmit(message: Message) {
        const chatId = await handleNewChat(message, undefined, {
            // A failed create shows a toast; its Retry re-runs this whole
            // submit so the user does not have to retype the message.
            onRetry: () => handleInitialSubmit(message),
        });
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
            rejectedApiKey={rejectedApiKey}
            onDismissInvalidApiKey={dismissInvalidApiKey}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            detach={detach}
        />
    );
}
