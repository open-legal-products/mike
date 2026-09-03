// Unit tests for the chat service's title-persistence write.
//
// `updateChatTitle` is the query that moved out of chat.routes.ts. The route's
// SSE loop calls it twice with opposite failure policies — rethrow inside the
// title promise, ignore for the truncated-content fallback — so what matters
// here is that the function issues exactly the update the route used to issue
// inline, and that it REPORTS a driver error instead of throwing or
// swallowing it.

import { describe, expect, it } from "vitest";

import type { Db } from "../../../lib/supabase";
import { updateChatTitle } from "../chat.service";

type Call = {
    table: string;
    op: string;
    payload?: Record<string, unknown>;
    filters: Record<string, unknown>;
};

/** Minimal PostgREST-shaped double: records the builder chain, resolves to `{ error }`. */
function makeDb(error: unknown = null) {
    const calls: Call[] = [];
    function from(table: string) {
        const call: Call = { table, op: "select", filters: {} };
        calls.push(call);
        const builder: Record<string, unknown> = {
            update(payload: Record<string, unknown>) {
                call.op = "update";
                call.payload = payload;
                return builder;
            },
            eq(column: string, value: unknown) {
                call.filters[column] = value;
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

describe("updateChatTitle", () => {
    it("updates the chats row addressed by id", async () => {
        const { db, calls } = makeDb();

        const result = await updateChatTitle(db, {
            chatId: "chat-1",
            title: "Lease review",
        });

        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([
            {
                table: "chats",
                op: "update",
                payload: { title: "Lease review" },
                filters: { id: "chat-1" },
            },
        ]);
    });

    it("reports a driver error rather than throwing it", async () => {
        const driverError = { message: "permission denied for table chats" };
        const { db } = makeDb(driverError);

        const result = await updateChatTitle(db, {
            chatId: "chat-1",
            title: "Lease review",
        });

        // The route rethrows exactly this value from inside the title
        // promise, so the object must be handed back untouched.
        expect(result).toEqual({ ok: false, error: driverError });
    });
});
