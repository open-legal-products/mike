// Unit tests for the project-chat service writes that moved out of
// projectChat.routes.ts.
//
// `insertAssistantMessage` replaced three near-identical inline inserts (the
// completed turn, the partial saved after a client abort, and the error
// turn). All three normalised empty arrays to NULL before inserting; that
// normalisation now lives in one place, so it is pinned here. The title
// update is the chat module's — reached through its facade — so the only
// thing to assert about it is that project-chat really does share it.

import { describe, expect, it } from "vitest";

import type { Db } from "../../../lib/supabase";
import type { AssistantEvent } from "../../../lib/chat";
import { updateChatTitle as chatModuleUpdateChatTitle } from "../../chat/chat.service";
import {
    insertAssistantMessage,
    updateChatTitle,
} from "../projectChat.service";

type Call = {
    table: string;
    op: string;
    payload?: Record<string, unknown>;
};

/** Minimal PostgREST-shaped double: records the builder chain, resolves to `{ error }`. */
function makeDb(error: unknown = null) {
    const calls: Call[] = [];
    function from(table: string) {
        const call: Call = { table, op: "select" };
        calls.push(call);
        const builder: Record<string, unknown> = {
            insert(payload: Record<string, unknown>) {
                call.op = "insert";
                call.payload = payload;
                return builder;
            },
            then(onFulfilled: (result: { error: unknown }) => unknown) {
                return Promise.resolve({ error }).then(onFulfilled);
            },
        };
        return builder;
    }
    return { db: { from } as unknown as Db, calls };
}

const events: AssistantEvent[] = [
    { type: "content", text: "The lease renews annually." },
];
const citations = [{ document_id: "doc-1" }];

describe("insertAssistantMessage", () => {
    it("inserts the assistant turn with its events and citations", async () => {
        const { db, calls } = makeDb();

        const result = await insertAssistantMessage(db, {
            chatId: "chat-1",
            events,
            citations,
        });

        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([
            {
                table: "chat_messages",
                op: "insert",
                payload: {
                    chat_id: "chat-1",
                    role: "assistant",
                    content: events,
                    citations,
                },
            },
        ]);
    });

    it("stores NULL rather than an empty array for events and citations", async () => {
        const { db, calls } = makeDb();

        await insertAssistantMessage(db, {
            chatId: "chat-1",
            events: [],
            citations: [],
        });

        expect(calls[0].payload).toEqual({
            chat_id: "chat-1",
            role: "assistant",
            content: null,
            citations: null,
        });
    });

    it("reports a driver error so the route can log its own save failure", async () => {
        const driverError = { message: "insert violates foreign key" };
        const { db } = makeDb(driverError);

        const result = await insertAssistantMessage(db, {
            chatId: "chat-1",
            events,
            citations,
        });

        expect(result).toEqual({ ok: false, error: driverError });
    });
});

describe("project-chat title persistence", () => {
    it("reuses the chat module's updateChatTitle through its facade", () => {
        // A project chat is a `chats` row; the two modules must not drift
        // into two different implementations of the same update.
        expect(updateChatTitle).toBe(chatModuleUpdateChatTitle);
    });
});
