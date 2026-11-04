import { describe, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";

// Permissions are covered by the access suite; here every row is readable so
// the reads themselves are under test.
vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    checkProjectAccess: async () => ({ ok: true }),
    checkWorkflowAccess: async () => ({ ok: true }),
    createDocumentAccessChecker: () => async () => ({ ok: true }),
    createSharedRowAccessChecker: () => async () => ({ ok: true }),
}));
import { buildUserAccountExport, buildUserChatsExport } from "../buildJsonExport";

const stamp = (i: number) => `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`;
const userId = "u1";

function workspace(chatCount: number, documentCount: number) {
    const chatIds = Array.from({ length: chatCount }, (_, i) => `chat-${String(i).padStart(3, "0")}`);
    const documentIds = Array.from({ length: documentCount }, (_, i) => `doc-${String(i).padStart(3, "0")}`);
    return {
        chatIds,
        documentIds,
        tables: {
            user_profiles: [{ id: "profile", user_id: userId }],
            projects: [{ id: "p1", user_id: userId, org_id: null, project_id: null, archived_at: null, created_at: stamp(0) }],
            chats: chatIds.map((id, i) => ({ id, user_id: userId, org_id: null, project_id: null, archived_at: null, created_at: stamp(i) })).reverse(),
            chat_messages: chatIds.flatMap((chat_id, i) => [0, 1, 2].map((n) => ({ id: `${chat_id}-m${n}`, chat_id, created_at: stamp(i * 3 + n) }))),
            documents: documentIds.map((id, i) => ({ id, user_id: userId, org_id: null, project_id: "p1", archived_at: null, created_at: stamp(i) })),
            document_versions: documentIds.map((document_id, i) => ({ id: `${document_id}-v1`, document_id, created_at: stamp(i) })),
            memory_files: [{ id: "m1", scope: "user", user_id: userId, org_id: null, enabled: true, epoch: 0, revision: 1, content: "# Memory", content_sha256: null, size_bytes: 8, status: "idle" }],
        },
    };
}

describe("export reads", () => {
    it("read every row behind a gateway that returns fewer rows than requested, in the promised order", async () => {
        const { chatIds, documentIds, tables } = workspace(10, 120);
        // 3 rows per response, as a gateway configured below the page size
        // behaves: a read that stopped on the first short page would export
        // 3 of 10 chats with no error.
        const fake = tableDb(tables, { maxRows: 3, maxInList: 50 });

        const chats = await buildUserChatsExport(fake.db, userId, "u1@example.com", null);
        expect(chats.assistant_chats.chats.map((c) => c.id)).toEqual(chatIds);
        expect(chats.assistant_chats.messages).toHaveLength(30);

        const account = await buildUserAccountExport(fake.db, userId, "u1@example.com", null);
        expect(account.chats.chats.map((c) => c.id)).toEqual(chatIds);
        expect(account.chats.messages.map((m) => m.id)).toEqual(chatIds.flatMap((id) => [0, 1, 2].map((n) => `${id}-m${n}`)));
        expect(account.documents.map((d) => d.id)).toEqual(documentIds);
        expect(account.document_versions).toHaveLength(120);
        expect(account.memory.markdown).toBe("# Memory");
        expect(Math.max(...fake.calls.flatMap((call) => call.inSizes))).toBeLessThanOrEqual(50);
        expect(Math.max(...fake.calls.map((call) => call.returned))).toBeLessThanOrEqual(3);
    });

    it("fail rather than export a partial table", async () => {
        const { tables } = workspace(2, 2);
        const fake = tableDb(tables, { failSelects: ["chat_messages"] });
        await expect(buildUserChatsExport(fake.db, userId, "u1@example.com", null)).rejects.toThrow(/chat_messages/);
    });
});
