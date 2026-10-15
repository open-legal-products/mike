import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { listTabularReviews } from "../tabular.reviews";

describe("review history status enrichment", () => {
    it("requests statuses only for the authorized page and preserves review metadata", async () => {
        const rpc = vi.fn(async (name: string) => ({
            data: name === "get_tabular_reviews_overview"
                ? [{ id: "r1", title: "Review", project_id: "p1" }]
                : [{ id: "r1", is_running: true, is_complete: false }],
            error: null,
        }));
        const inIds = vi.fn().mockResolvedValue({ data: [{ id: "p1", name: "Matter Alpha" }], error: null });
        const select = vi.fn(() => ({ in: inIds }));
        const from = vi.fn(() => ({ select }));
        const result = await listTabularReviews({ rpc, from } as unknown as Db, {
            userId: "u1", userEmail: " USER@EXAMPLE.COM ", projectIdFilter: null,
            scope: "all", workspace: "personal", pagination: { limit: 31, offset: 0 },
            searchTerm: null, sort: { key: "updated", direction: "desc" }, includeStatus: true,
        });
        expect(rpc).toHaveBeenLastCalledWith("get_tabular_review_history_status", {
            p_user_id: "u1", p_user_email: "user@example.com", p_review_ids: ["r1"],
        });
        expect(from).toHaveBeenCalledWith("projects");
        expect(select).toHaveBeenCalledWith("id, name");
        expect(inIds).toHaveBeenCalledWith("id", ["p1"]);
        expect(result).toEqual({ ok: true, data: [{
            id: "r1", title: "Review", project_id: "p1", project_name: "Matter Alpha", is_running: true, is_complete: false,
        }] });
    });
});
