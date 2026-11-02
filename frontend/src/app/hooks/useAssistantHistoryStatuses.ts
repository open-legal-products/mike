"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    hasAssistantTurn,
    subscribeAssistantTurns,
} from "@/app/lib/assistantTurns";

type AssistantHistoryStatus = "loading" | "complete";

function withAssistantHistoryStatus(
    current: Record<string, AssistantHistoryStatus>,
    chatId: string,
    status?: AssistantHistoryStatus,
) {
    if (status) {
        return current[chatId] === status
            ? current
            : { ...current, [chatId]: status };
    }
    if (!(chatId in current)) return current;
    const next = { ...current };
    delete next[chatId];
    return next;
}

export function useAssistantHistoryStatuses({
    activeChatId,
    sideChatId = null,
    chatIds,
    onActivity,
}: {
    activeChatId: string | null;
    /**
     * A second chat on screen beside the active one. Its answers are read as
     * they arrive too, so it is never marked as finished-and-unread.
     */
    sideChatId?: string | null;
    chatIds: readonly string[];
    onActivity?: (chatId: string) => void;
}) {
    const activeChatIdRef = useRef(activeChatId);
    const sideChatIdRef = useRef(sideChatId);
    const onActivityRef = useRef(onActivity);
    const [statuses, setStatuses] = useState<
        Record<string, AssistantHistoryStatus>
    >({});

    useEffect(() => {
        activeChatIdRef.current = activeChatId;
        sideChatIdRef.current = sideChatId;
        onActivityRef.current = onActivity;
    }, [activeChatId, sideChatId, onActivity]);

    useEffect(
        () =>
            subscribeAssistantTurns((chatId, change, turn) => {
                onActivityRef.current?.(chatId);
                setStatuses((current) =>
                    withAssistantHistoryStatus(
                        current,
                        chatId,
                        change === "begin"
                            ? "loading"
                            : chatId === activeChatIdRef.current ||
                                chatId === sideChatIdRef.current ||
                                turn.assistant.error
                              ? undefined
                              : "complete",
                    ),
                );
            }),
        [],
    );

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile persisted turn state when the visible history set or selected chat changes
        setStatuses((current) => {
            let next = current;
            // Opening a chat, in either place, is reading its answer.
            for (const shownChatId of [activeChatId, sideChatId]) {
                if (!shownChatId) continue;
                next = withAssistantHistoryStatus(
                    next,
                    shownChatId,
                    hasAssistantTurn(shownChatId) ? "loading" : undefined,
                );
            }
            for (const chatId of chatIds) {
                if (
                    chatId !== activeChatId &&
                    chatId !== sideChatId &&
                    hasAssistantTurn(chatId)
                ) {
                    next = withAssistantHistoryStatus(next, chatId, "loading");
                }
            }
            return next;
        });
    }, [activeChatId, sideChatId, chatIds]);

    const clearStatus = useCallback((chatId: string) => {
        setStatuses((current) =>
            withAssistantHistoryStatus(current, chatId, undefined),
        );
    }, []);

    return { statuses, clearStatus };
}
