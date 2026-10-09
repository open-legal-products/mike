"use client";

import { useState, type ReactNode } from "react";
import type { Message } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";
import { findPendingAskInput } from "@/app/lib/pendingAskInput";

function pendingInput(messages: Message[]) {
    const pending = findPendingAskInput(messages);
    // The prompt answers a stored message, so it waits for the message's id.
    if (!pending?.message.id) return null;
    return {
        key: `${pending.message.id}:${pending.event.event_id}`,
        assistantMessageId: pending.message.id,
        event: pending.event,
    };
}

export function ChatInputPrompt({
    messages,
    chatKey,
    canSend = true,
    chatLoading = false,
    onSubmit,
    onCancel,
    children,
}: {
    messages: Message[];
    chatKey: string | null | undefined;
    /**
     * Tri-state, like ChatInput's: `null` means "not known yet". Only `true`
     * may raise an ask-input prompt, so an unresolved role behaves like a
     * refusal instead of prompting somebody who may turn out to be a viewer.
     */
    canSend?: boolean | null;
    /** The thread's history is still arriving; prompt nothing until it has. */
    chatLoading?: boolean;
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
        chatLoading ||
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
