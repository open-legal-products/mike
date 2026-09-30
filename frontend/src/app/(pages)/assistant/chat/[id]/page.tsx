"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatRoute } from "@/app/hooks/useChatRoute";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { loadAssistantChat } from "@/app/lib/assistantTurns";
import { can, roleFrom } from "@/app/lib/permissions";
import type { Chat } from "@/app/components/shared/types";

// Serves `/assistant` (a new chat) as well as `/assistant/chat/:id`: the
// first answer adopts its chat id in place, so it streams without a remount.
export default function AssistantChatPage() {
    const router = useRouter();
    const { chatId: id, openChat, adoptChat, claimCreated } = useChatRoute(
        "/assistant/chat",
        "/assistant",
    );

    const { setCurrentChatId, newChatMessages, setNewChatMessages, loadChats } =
        useChatHistoryContext();

    // A workflow creates the chat itself and hands its first message over.
    const initialMessages = newChatMessages ?? [];
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        rejectedApiKey,
        dismissInvalidApiKey,
        resetChat,
    } = useAssistantChat({
        initialMessages,
        chatId: id || undefined,
        onChatCreated: (createdId) => {
            adoptChat(createdId);
            // The server has stored the chat by now; list it right away
            // rather than when the first answer finishes.
            void loadChats();
        },
    });

    const hasAutoSent = useRef(false);
    const loadedChatId = useRef<string | null>(null);
    // Whether the caller may write here, from the standing GET /chat/:id
    // serves. Grant-reachable chats appear in the global sidebar since the
    // parity change, so a project VIEWER can land on this page — dropping
    // the served role handed them a live composer whose sends 403. A new
    // chat, or arriving from a workflow, means the caller creates the
    // thread: creator.
    //
    // Fail-closed until the served standing lands: `false` on every cold
    // load, which used to read "Viewing only — sending needs edit access" at
    // a chat's own owner. `accessResolved` below is what keeps that false
    // from being shown as an accusation — the composer is not rendered at
    // all until the answer arrives. A failed getChat leaves it false and
    // redirects.
    const startsFresh = !id || initialMessages.length > 0;
    const [canSend, setCanSend] = useState<boolean>(startsFresh);
    // Until the served role lands for the FIRST time, the standing is unknown
    // rather than denied. Keep the composer off the page for that window so a
    // caller who does have edit access never reads the read-only placeholder;
    // a new chat already knows the answer.
    const [accessResolved, setAccessResolved] = useState<boolean>(startsFresh);
    // Separate from canSend: while this is true the composer is closed because
    // the thread's messages have not arrived, not because the caller lacks a
    // grant, and the composer must say that rather than blame permissions.
    // This is the switch-to-another-thread case, where the standing is already
    // resolved and the composer stays on the page while the history lands. An
    // answer still streaming into the thread does not hold the load open: the
    // history is fetched at once and the live answer is laid over it.
    const [chatLoading, setChatLoading] = useState<boolean>(!startsFresh);
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
        setCurrentChatId(id || null);
    }, [id, setCurrentChatId]);

    useEffect(() => {
        // The chat the first answer just created: its messages are on screen.
        if (claimCreated(id)) {
            const firstUserMessage = messages.find(
                (message) => message.role === "user",
            );
            // eslint-disable-next-line react-hooks/set-state-in-effect -- each chat id selects its own view state
            setChatModel(firstUserMessage?.model ?? null);
            setChatReasoningLevel(firstUserMessage?.reasoning ?? null);
            return;
        }
        if (!id) {
            setChat(null);
            setChatModel(undefined);
            setChatReasoningLevel(undefined);
            setMessages([]);
            setCanSend(true);
            setAccessResolved(true);
            setChatLoading(false);
            return;
        }
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
        // simply waiting for a thread.
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

    // Leaving is not Stop: resetChat detaches, so the answer still streaming
    // here finishes and is stored server-side.
    function handleNewChat() {
        resetChat();
        setNewChatMessages(null);
        openChat("");
    }

    const isNewChat = !id;

    return (
        <ChatView
            chatId={id || null}
            chat={chat}
            onInitialSubmit={
                isNewChat && messages.length === 0
                    ? (message) => void handleChat(message)
                    : undefined
            }
            chatModel={isNewChat ? (messages[0]?.model ?? null) : chatModel}
            chatReasoningLevel={
                isNewChat ? (messages[0]?.reasoning ?? null) : chatReasoningLevel
            }
            messages={messages}
            rejectedApiKey={rejectedApiKey}
            onDismissInvalidApiKey={dismissInvalidApiKey}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            onNewChat={handleNewChat}
            canSend={canSend}
            accessResolved={accessResolved}
            chatLoading={chatLoading}
        />
    );
}
