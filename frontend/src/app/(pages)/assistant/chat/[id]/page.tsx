"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { loadAssistantChat } from "@/app/lib/assistantTurns";
import { can, roleFrom } from "@/app/lib/permissions";
import type { Chat } from "@/app/components/shared/types";

export default function AssistantChatPage() {
    const router = useRouter();
    const params = useParams();
    const id = params.id as string;

    const { setCurrentChatId, newChatMessages, setNewChatMessages } =
        useChatHistoryContext();

    const initialMessages = newChatMessages ?? [];
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        detach,
    } = useAssistantChat({ initialMessages, chatId: id });

    const hasAutoSent = useRef(false);
    const loadedChatId = useRef<string | null>(null);
    // Whether the caller may write here, from the standing GET /chat/:id
    // serves. Grant-reachable chats appear in the global sidebar since the
    // parity change, so a project VIEWER can land on this page — dropping
    // the served role handed them a live composer whose sends 403. Arriving
    // via "new chat" means the caller just created the thread: creator.
    const [canSend, setCanSend] = useState<boolean>(
        initialMessages.length > 0,
    );
    // Until the served role lands for the FIRST time, the standing is unknown
    // rather than denied. Keep the composer off the page for that window so a
    // caller who does have edit access never reads the read-only placeholder;
    // arriving from "new chat" already knows the answer.
    const [accessResolved, setAccessResolved] = useState<boolean>(
        initialMessages.length > 0,
    );
    // Separate from canSend: while this is true the composer is closed because
    // the thread's messages have not arrived, not because the caller lacks a
    // grant. A detached response holds the load open until the server has
    // stored it, and the composer must say that rather than blame permissions.
    // This is the switch-to-another-thread case, where the standing is already
    // resolved and the composer stays on the page while the history lands.
    const [chatLoading, setChatLoading] = useState<boolean>(
        initialMessages.length === 0,
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
        if (loadedChatId.current === id) return;
        loadedChatId.current = id;
        let cancelled = false;
        // The composer stays closed until the load resolves, but through
        // chatLoading rather than canSend: retiring the grant here made the
        // read-only copy ("needs edit access") the message a reader saw while
        // simply waiting for a thread — including the seconds a detached
        // response holds the load open.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- a newly selected chat must load before sending
        setChatLoading(true);
        setMessages([]);

        loadAssistantChat(id)
            .then(({ chat, messages: loaded }) => {
                if (cancelled) return;
                setChat(chat);
                setChatModel(chat.model ?? null);
                setChatReasoningLevel(chat.reasoning_level ?? null);
                setCanSend(can(roleFrom(chat), "content.edit"));
                setAccessResolved(true);
                setChatLoading(false);
                if (loaded.length > 0) {
                    setMessages(loaded);
                } else {
                    router.replace("/assistant");
                }
            })
            .catch(() => {
                if (!cancelled) router.replace("/assistant");
            });
        return () => {
            cancelled = true;
            // StrictMode replays the effect, and the replacement load must
            // be allowed after retiring the first one's callback.
            loadedChatId.current = null;
        };
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
            detach={detach}
            canSend={canSend}
            accessResolved={accessResolved}
            chatLoading={chatLoading}
        />
    );
}
