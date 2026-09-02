"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { getChat } from "@/app/lib/mikeApi";
import { replaceMessageById } from "@/app/lib/chatAgents";
import type { Message } from "@/app/components/shared/types";

export default function AssistantChatPage() {
    const router = useRouter();
    const params = useParams();
    const id = params.id as string;

    const { setCurrentChatId, newChatMessages, setNewChatMessages } =
        useChatHistoryContext();

    const initialMessages = newChatMessages ?? [];
    const { messages, isResponseLoading, handleChat, setMessages, cancel } =
        useAssistantChat({ initialMessages, chatId: id });

    const hasAutoSent = useRef(false);
    const hasLoaded = useRef(false);
    const [chatModel, setChatModel] = useState<string | null | undefined>(
        initialMessages.length > 0
            ? (initialMessages[0]?.model ?? null)
            : undefined,
    );
    const [chatReasoningLevel, setChatReasoningLevel] = useState<
        NonNullable<(typeof initialMessages)[number]["reasoning"]> | null | undefined
    >(
        initialMessages.length > 0
            ? (initialMessages[0]?.reasoning ?? null)
            : undefined,
    );

    useEffect(() => {
        setCurrentChatId(id);
    }, [id, setCurrentChatId]);

    useEffect(() => {
        if (initialMessages.length > 0) {
            if (newChatMessages) setNewChatMessages(null);
            return;
        }
        if (hasLoaded.current || messages.length > 0) return;
        hasLoaded.current = true;

        getChat(id)
            .then(({ chat, messages: loaded }) => {
                setChatModel(chat.model ?? null);
                setChatReasoningLevel(chat.reasoning_level ?? null);
                if (loaded.length > 0) {
                    setMessages(loaded);
                } else {
                    router.replace("/assistant");
                }
            })
            .catch(() => router.replace("/assistant"));
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    // An accepted proposal rewrites one specific response, which may not be
    // the newest one — so the swap matches by id rather than by position.
    const handleMessageRevised = useCallback(
        (revised: Message) => {
            if (!revised.id) return;
            setMessages((prev) =>
                replaceMessageById(prev, revised.id!, () => revised),
            );
        },
        [setMessages],
    );

    return (
        <ChatView
            chatId={id}
            chatModel={chatModel}
            chatReasoningLevel={chatReasoningLevel}
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            onMessageRevised={handleMessageRevised}
        />
    );
}
