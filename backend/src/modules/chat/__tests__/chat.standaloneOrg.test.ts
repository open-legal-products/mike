import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const upsertContentGrant = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/contentAccess", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contentAccess")>()),
    upsertContentGrant,
}));

import { createChat } from "../chat.crud";
import { grantChatAccess } from "../chat.sharing";

// A chat started on its own belongs to the workspace it is started in: the
// organization the client names as `org_id`, or Personal when it names none.
// Inside a project the project decides.

const WHO = { userId: "u1", userEmail: "u1@example.com" };

beforeEach(() => {
    vi.clearAllMocks();
});

describe("createChat", () => {
    it("files a standalone chat under the organization its author is working in", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { role: "member" } },
            { table: "organizations", data: { kind: "team" } },
            { table: "chats", op: "insert", data: { id: "chat-1" } },
        ]);
        await expect(
            createChat(fake.db, { ...WHO, projectId: null, orgId: "org-1" }),
        ).resolves.toEqual({ ok: true, id: "chat-1" });
        // Membership is asked of THIS user in THIS organization.
        expect(fake.calls[0].filters).toEqual([
            ["is", "organizations.deleted_at", null],
            ["eq", "org_id", "org-1"],
            ["eq", "user_id", "u1"],
        ]);
        expect(fake.calls[2].payload).toEqual({
            user_id: "u1",
            project_id: null,
            org_id: "org-1",
        });
        fake.done();
    });

    it.each([undefined, null, ""])(
        "keeps it personal when no organization is named (%j), without asking about organizations",
        async (orgId) => {
            const fake = scriptedDb([
                { table: "chats", op: "insert", data: { id: "chat-1" } },
            ]);
            await expect(
                createChat(fake.db, { ...WHO, projectId: null, orgId }),
            ).resolves.toEqual({ ok: true, id: "chat-1" });
            expect(fake.calls[0].payload).toMatchObject({ org_id: null });
            fake.done();
        },
    );

    it("400s an organization the caller is not in, before writing anything", async () => {
        const fake = scriptedDb([{ table: "org_members", data: null }]);
        await expect(
            createChat(fake.db, { ...WHO, projectId: null, orgId: "org-x" }),
        ).resolves.toEqual({
            ok: false,
            kind: "access",
            status: 400,
            detail: "You are not a member of that organization.",
        });
        fake.done();
    });

    it("400s the caller's own personal organization named by id: Personal is naming none", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { role: "owner" } },
            { table: "organizations", data: { kind: "personal" } },
        ]);
        await expect(
            createChat(fake.db, { ...WHO, projectId: null, orgId: "mine" }),
        ).resolves.toMatchObject({ ok: false, kind: "access", status: 400 });
        fake.done();
    });
});

describe("grantChatAccess", () => {
    const chat = (orgId: string | null) => ({
        id: "chat-1",
        title: null,
        user_id: "u1",
        project_id: null,
        model: null,
        reasoning_level: null,
        org_id: orgId,
    });

    it("limits sharing an organization's chat to that organization's members", async () => {
        upsertContentGrant.mockResolvedValue({
            ok: false,
            kind: "validation",
            detail: "her@example.com is not a member of this organization.",
        });
        const fake = scriptedDb([
            { table: "user_profiles", data: { email: "u1@example.com" } },
            { table: "organizations", data: { kind: "team" } },
        ]);
        const result = await grantChatAccess(fake.db, {
            chatId: "chat-1",
            chat: chat("org-1"),
            userId: "u1",
            email: "her@example.com",
            role: "editor",
        });
        expect(upsertContentGrant).toHaveBeenCalledWith(
            fake.db,
            expect.objectContaining({ orgId: "org-1" }),
        );
        expect(result).toMatchObject({ ok: false, kind: "validation" });
        fake.done();
    });

    it.each([
        ["a personal chat", null, []],
        [
            "a chat in a personal organization",
            "mine",
            [{ table: "organizations", data: { kind: "personal" } }],
        ],
    ])("lets %s be shared with anyone", async (_label, orgId, steps) => {
        upsertContentGrant.mockResolvedValue({ ok: true, grant: { id: "g1" } });
        const fake = scriptedDb([
            { table: "user_profiles", data: { email: "u1@example.com" } },
            ...steps,
        ]);
        await grantChatAccess(fake.db, {
            chatId: "chat-1",
            chat: chat(orgId),
            userId: "u1",
            email: "her@example.com",
            role: "editor",
        });
        expect(upsertContentGrant).toHaveBeenCalledWith(
            fake.db,
            expect.objectContaining({ orgId: null }),
        );
        fake.done();
    });
});
