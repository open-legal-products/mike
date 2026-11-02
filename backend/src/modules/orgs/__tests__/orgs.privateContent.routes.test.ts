import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), personal: false }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("../../../lib/personalOrgs", () => ({ isPersonalOrg: async () => mocks.personal }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => { res.locals.userId = "authenticated-actor"; next(); },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import { orgsRouter } from "../orgs.routes";
const app = express(); app.use(express.json()); app.use("/orgs", orgsRouter);
const itemId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { mocks.personal = false; mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null }); });
describe("private content HTTP boundary", () => {
    it("ignores a spoofed actor and uses the authenticated one for openings and permission changes", async () => {
        await request(app).post(`/orgs/org/private-content/document/${itemId}/open`).send({ userId: "victim", actor_id: "victim" }).expect(204);
        expect(mocks.rpc).toHaveBeenLastCalledWith("open_org_private_content", { p_org_id: "org", p_actor_id: "authenticated-actor", p_kind: "document", p_item_id: itemId });
        await request(app).put(`/orgs/org/members/${itemId}/private-content-permission`).send({ enabled: true, actor_id: "victim" }).expect(204);
        expect(mocks.rpc).toHaveBeenLastCalledWith("set_org_private_content_permission", { p_org_id: "org", p_actor_id: "authenticated-actor", p_target_id: itemId, p_enabled: true });
    });
    it("denies personal workspaces before any private-content RPC", async () => {
        mocks.personal = true;
        await request(app).get("/orgs/personal/private-content").expect(404);
        await request(app).post(`/orgs/personal/private-content/document/${itemId}/open`).expect(404);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it("maps authorization failures and exposes no database message", async () => {
        mocks.rpc.mockResolvedValue({ error: { code: "42501", message: "raw database secret" } });
        const response = await request(app).get("/orgs/org/private-content").expect(403);
        expect(response.body.detail).toBe("You do not have permission to access private organization content.");
    });
    it("clamps pagination and rejects invalid resource kinds", async () => {
        await request(app).get("/orgs/org/private-content?limit=999&offset=-2&search=NDA").expect(200);
        expect(mocks.rpc).toHaveBeenCalledWith("list_org_private_content", { p_org_id: "org", p_actor_id: "authenticated-actor", p_limit: 101, p_offset: 0, p_search: "NDA" });
        mocks.rpc.mockClear();
        await request(app).post(`/orgs/org/private-content/users/${itemId}/open`).expect(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
