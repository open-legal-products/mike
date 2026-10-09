import { describe, expect, it } from "vitest";
import type { AssistantEvent, Message } from "@/app/components/shared/types";
import { findPendingAskInput } from "./pendingAskInput";

const ask = { type: "ask_inputs", event_id: "ask-1", items: [] } as unknown as AssistantEvent;
const answer = { type: "ask_inputs_response", event_id: "ask-1" } as unknown as AssistantEvent;
const content = { type: "content", text: "Here you go." } as AssistantEvent;

function assistant(events: AssistantEvent[]): Message {
    return { role: "assistant", content: "", events } as Message;
}
const user = { role: "user", content: "hi" } as Message;

describe("findPendingAskInput", () => {
    it("finds a request that is the latest thing in the thread", () => {
        const messages = [user, assistant([content, ask])];

        expect(findPendingAskInput(messages)).toMatchObject({
            messageIndex: 1,
            event: ask,
        });
    });

    it("treats a recorded response as settling the request", () => {
        expect(findPendingAskInput([user, assistant([ask, answer])])).toBeNull();
    });

    it("treats a later user message as settling the request", () => {
        expect(
            findPendingAskInput([user, assistant([ask]), user]),
        ).toBeNull();
    });

    it("returns nothing when no request was made", () => {
        expect(findPendingAskInput([user, assistant([content])])).toBeNull();
        expect(findPendingAskInput([])).toBeNull();
    });
});
