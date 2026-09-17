"use client";

import { useState, type ReactNode } from "react";
import type { Message } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";

function pendingInput(messages: Message[]) {
    for (
        let messageIndex = messages.length - 1;
        messageIndex >= 0;
        messageIndex--
    ) {
        const message = messages[messageIndex];
        if (message.role === "user") return null;
        if (message.role !== "assistant" || !message.events) continue;
        for (
            let eventIndex = message.events.length - 1;
            eventIndex >= 0;
            eventIndex--
        ) {
            const event = message.events[eventIndex];
            if (event.type === "ask_inputs_response") return null;
            if (event.type === "ask_inputs") {
                if (!message.id) return null;
                return {
                    key: `${message.id}:${event.event_id}`,
                    assistantMessageId: message.id,
                    event,
                };
            }
        }
    }
    return null;
}

export function ChatInputPrompt({
    messages,
    chatKey,
    canSend = true,
    onSubmit,
    onCancel,
    children,
}: {
    messages: Message[];
    chatKey: string | null | undefined;
    canSend?: boolean;
    onSubmit: NonNullable<Parameters<typeof AskInputPopup>[0]["onSubmit"]>;
    onCancel: () => void;
    children: ReactNode;
}) {
    const [hiddenInputs, setHiddenInputs] = useState({
        chatKey,
        keys: new Set<string>(),
    });
    // Reset on every thread change, including a return to a dismissed prompt.
    if (hiddenInputs.chatKey !== chatKey) {
        setHiddenInputs({ chatKey, keys: new Set<string>() });
    }
    const activeInput = pendingInput(messages);
    if (
        !canSend ||
        !activeInput ||
        (hiddenInputs.chatKey === chatKey &&
            hiddenInputs.keys.has(activeInput.key))
    ) {
        return children;
    }

    function hideInput() {
        if (!activeInput) return;
        setHiddenInputs((current) => ({
            chatKey,
            keys: new Set(current.chatKey === chatKey ? current.keys : []).add(
                activeInput.key,
            ),
        }));
    }

    return (
        <AskInputPopup
            key={`${chatKey ?? "new"}:${activeInput.key}`}
            event={activeInput.event}
            assistantMessageId={activeInput.assistantMessageId}
            onSubmit={(response, content, files) => {
                hideInput();
                onSubmit(response, content, files);
            }}
            onDismiss={() => {
                hideInput();
                onCancel();
            }}
        />
    );
}
