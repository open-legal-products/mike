import { beforeEach, describe, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";

const access = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/access", async (original) => ({
    ...(await original<typeof import("../../../lib/access")>()),
    checkProjectAccess: access,
}));

import { listProjectChats } from "../projects.service";

describe("listProjectChats", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        access.mockResolvedValue({ ok: true, projectRole: "editor" });
    });

    it("lists every project chat past max_rows, newest activity first", async () => {
        const chats = Array.from({ length: 1200 }, (_, i) => ({
            id: `chat-${String(i).padStart(4, "0")}`, project_id: "project-1", user_id: null,
            updated_at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
        }));
        const fake = tableDb({ chats, user_profiles: [] });
        const result = await listProjectChats(fake.db, { projectId: "project-1", userId: "user-1" });
        const ids = result.ok ? (result.chats as { id: string }[]).map((chat) => chat.id) : [];
        expect(ids).toHaveLength(1200);
        expect(ids[0]).toBe("chat-1199");
    });
});
