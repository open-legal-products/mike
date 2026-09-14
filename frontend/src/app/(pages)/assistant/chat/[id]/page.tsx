"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { getChat } from "@/app/lib/mikeApi";
import { can, roleFrom } from "@/app/lib/permissions";
import { replaceMessageById } from "@/app/lib/chatAgents";
import type { Chat, Message } from "@/app/components/shared/types";

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
    // Whether the caller may write here, from the standing GET /chat/:id
    // serves. Grant-reachable chats appear in the global sidebar since the
    // parity change, so a project VIEWER can land on this page — dropping
    // the served role handed them a live composer whose sends 403. Arriving
    // via "new chat" means the caller just created the thread: creator.
    const [canSend, setCanSend] = useState<boolean>(
        initialMessages.length > 0,
    );
    const [chat, setChat] = useState<Chat | null>(null);
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
                setChat(chat);
                setChatModel(chat.model ?? null);
                setChatReasoningLevel(chat.reasoning_level ?? null);
                setCanSend(can(roleFrom(chat), "content.edit"));
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
            chat={chat}
            chatModel={chatModel}
            chatReasoningLevel={chatReasoningLevel}
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            canSend={canSend}
            onMessageRevised={handleMessageRevised}
        />
    );
}
