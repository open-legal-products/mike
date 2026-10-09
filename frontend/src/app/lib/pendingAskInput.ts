import type { AssistantEvent, Message } from "@/app/components/shared/types";

export type PendingAskInput = {
    /** Index of the assistant message that asked. */
    messageIndex: number;
    message: Message;
    event: Extract<AssistantEvent, { type: "ask_inputs" }>;
};

/**
 * The request for input or approval the thread is currently waiting on, if
 * any. A request is pending only while it is the latest thing in the thread:
 * a later user message or a recorded response settles it.
 */
export function findPendingAskInput(
    messages: readonly Message[],
): PendingAskInput | null {
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
                return { messageIndex, message, event };
            }
        }
    }
    return null;
}
