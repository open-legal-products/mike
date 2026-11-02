import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

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

    it("orders project chat history by latest activity", async () => {
        const fake = scriptedDb([
            {
                table: "chats",
                data: [
                    {
                        id: "chat-1",
                        user_id: null,
                        updated_at: "2026-09-21T12:00:00Z",
                    },
                ],
            },
        ]);

        const result = await listProjectChats(fake.db, {
            projectId: "project-1",
            userId: "user-1",
        });

        expect(result.ok).toBe(true);
        expect(fake.calls[0].filters).toContainEqual([
            "order",
            "updated_at",
            { ascending: false },
        ]);
        fake.done();
    });
});
