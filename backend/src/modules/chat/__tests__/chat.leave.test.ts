import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { getAccessibleChat } from "../chat.access";
import { leaveChat, withChatLeaveAccess } from "../chat.sharing";

vi.mock("../chat.access", () => ({ getAccessibleChat: vi.fn() }));

function database(data: unknown[], error: unknown = null) {
    const query = {
        select: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve),
    };
    return { query, db: { from: vi.fn(() => query) } as unknown as Db };
}

beforeEach(() => {
    vi.mocked(getAccessibleChat).mockResolvedValue({
        ok: true,
        chat: { id: "chat-1", project_id: null, user_id: "creator", title: "Shared", model: null, reasoning_level: null },
        isCreator: false,
        projectRole: "viewer",
    });
});

describe("chat leave availability", () => {
    it("offers Leave only for a direct viewer/editor, not owners, projects or audited access", async () => {
        const { db, query } = database([{ chat_id: "shared" }]);
        const result = await withChatLeaveAccess(db, [
            { id: "shared", project_id: null, access_role: "editor" },
            { id: "owner", project_id: null, access_role: "owner" },
            { id: "project", project_id: "p1", access_role: "viewer" },
            { id: "audited", project_id: null, access_role: "viewer" },
        ], "  MEMBER@Example.com ");
        expect(result.ok && result.data.map(({ id, can_leave }) => [id, can_leave])).toEqual([
            ["shared", true], ["owner", false], ["project", false], ["audited", false],
        ]);
        expect(query.eq).toHaveBeenCalledWith("email", "member@example.com");
        expect(query.in).toHaveBeenCalledWith("chat_id", ["shared", "audited"]);
        expect(query.in).toHaveBeenCalledWith("role", ["editor", "viewer"]);
    });

    it("does not query grants for owners or project chats", async () => {
        const { db } = database([]);
        await withChatLeaveAccess(db, [
            { id: "owner", project_id: null, access_role: "owner" },
            { id: "project", project_id: "p1", access_role: "viewer" },
        ], "user@example.com");
        expect(db.from).not.toHaveBeenCalled();
    });

    it("bounds lookups on an unpaginated history", async () => {
        const { db, query } = database([]);
        await withChatLeaveAccess(db, Array.from({ length: 201 }, (_, i) => ({ id: String(i), project_id: null, access_role: "viewer" })), "user@example.com");
        expect(query.in.mock.calls.filter(([column]) => column === "chat_id").map(([, ids]) => ids.length)).toEqual([100, 100, 1]);
    });

    it("propagates lookup failures instead of claiming a recipient cannot leave", async () => {
        const { db } = database([], { message: "database unavailable" });
        expect(await withChatLeaveAccess(db, [{ id: "c", project_id: null, access_role: "viewer" }], "user@example.com"))
            .toMatchObject({ ok: false, kind: "error" });
    });
});

describe("leaving a chat", () => {
    it("normalizes the authenticated email and checks the role in the delete itself", async () => {
        const { db, query } = database([{ id: "grant-1" }]);
        expect(await leaveChat(db, { chatId: "chat-1", userId: "u1", userEmail: "  MEMBER@Example.com " })).toEqual({ ok: true, data: undefined });
        expect(db.from).toHaveBeenCalledWith("chat_access_grants");
        expect(query.eq.mock.calls).toEqual([["chat_id", "chat-1"], ["email", "member@example.com"]]);
        expect(query.in).toHaveBeenCalledWith("role", ["editor", "viewer"]);
    });

    it("does not claim success for audited access or a grant promoted to owner", async () => {
        const { db } = database([]);
        expect(await leaveChat(db, { chatId: "chat-1", userId: "u1", userEmail: "member@example.com" })).toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("does not mutate anything when the authenticated email is missing", async () => {
        const { db } = database([]);
        expect(await leaveChat(db, { chatId: "chat-1", userId: "u1", userEmail: null })).toMatchObject({ ok: false, kind: "forbidden" });
        expect(db.from).not.toHaveBeenCalled();
    });

    it("returns an internal failure when revoking the grant fails", async () => {
        const { db } = database([], { message: "private driver error" });
        expect(await leaveChat(db, { chatId: "chat-1", userId: "u1", userEmail: "member@example.com" })).toMatchObject({ ok: false, kind: "error" });
    });
});
