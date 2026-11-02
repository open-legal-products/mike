"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Message } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";
import { findPendingAskInput } from "@/app/lib/pendingAskInput";

type AskInputSubmit = NonNullable<Parameters<typeof AskInputPopup>[0]["onSubmit"]>;

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
    /**
     * Sends the answer. The prompt closes when `onAccepted` is called (the
     * server took the turn, so the answer can resume) or the returned
     * promise settles, whichever comes first; `null` or a rejection before
     * then keeps the form open for a retry.
     */
    onSubmit: (
        ...args: [...Parameters<AskInputSubmit>, onAccepted: () => void]
    ) => ReturnType<AskInputSubmit>;
    onCancel: () => void;
    children: ReactNode;
}) {
    // Keep the entered form mounted while the hook optimistically appends its
    // response event, so a rejected submission can be retried without retyping.
    const submissionRef = useRef<symbol | null>(null);
    useLayoutEffect(() => {
        submissionRef.current = null;
        return () => { submissionRef.current = null; };
    }, [chatKey]);
    const [submittedInput, setSubmittedInput] = useState<{
        chatKey: typeof chatKey;
        input: NonNullable<ReturnType<typeof pendingInput>>;
    } | null>(null);
    const [hiddenInputs, setHiddenInputs] = useState({
        chatKey,
        keys: new Set<string>(),
    });
    // Reset on every thread change, including a return to a dismissed prompt.
    if (hiddenInputs.chatKey !== chatKey) {
        setHiddenInputs({ chatKey, keys: new Set<string>() });
        setSubmittedInput(null);
    }
    const activeInput = submittedInput && submittedInput.chatKey === chatKey
        ? submittedInput.input
        : pendingInput(messages);
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
            onSubmit={async (response, content, files) => {
                const input = activeInput;
                const submission = Symbol();
                submissionRef.current = submission;
                setSubmittedInput({ chatKey, input });
                try {
                    // Settles on acceptance, without waiting for the answer
                    // to finish streaming.
                    const result = await new Promise<Awaited<ReturnType<AskInputSubmit>>>(
                        (resolve, reject) => {
                            Promise.resolve(
                                onSubmit(response, content, files, () => resolve()),
                            ).then(resolve, reject);
                        },
                    );
                    if (result === null || submissionRef.current !== submission) return null;
                    setHiddenInputs((current) => current.chatKey === chatKey
                        ? { chatKey, keys: new Set(current.keys).add(input.key) }
                        : current);
                    setSubmittedInput((current) => current?.chatKey === chatKey ? null : current);
                    return result;
                } catch {
                    return null;
                }
            }}
            onDismiss={() => {
                hideInput();
                onCancel();
            }}
        />
    );
}
