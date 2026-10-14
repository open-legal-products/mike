import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: "admin" as string | null,
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => ({ rpc: mocks.rpc }),
}));
vi.mock("../../../lib/access", () => ({
  getOrgRole: async () => mocks.role,
  isOrgAdmin: (r: string) => r === "admin" || r === "owner",
}));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "authenticated-actor";
    next();
  },
}));
import { auditRouter } from "../audit.routes";
const app = express();
app.use("/audit", auditRouter);
const orgId = "00000000-0000-4000-8000-000000000010";
const path = `/audit/actors?org_id=${orgId}`;
beforeEach(() => {
  mocks.role = "admin";
  mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null });
});
describe("audit actor search boundary", () => {
  it("uses the authenticated caller, bounds pages and returns only the requested slice", async () => {
    const users = Array.from({ length: 21 }, (_, i) => ({
      user_id: `u${i}`,
      display_name: `Person ${i}`,
      email: `u${i}@example.com`,
      profile_photo: null,
    }));
    mocks.rpc.mockResolvedValue({ data: users, error: null });
    const response = await request(app)
      .get(`${path}&q=Alex%20%26%20Pat&offset=20&actor_id=spoofed&limit=1000`)
      .expect(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "organization_audit_actors",
      {
        p_org_id: orgId,
        p_actor_id: "authenticated-actor",
        p_search: "Alex & Pat",
        p_offset: 20,
        p_limit: 21,
      },
    );
    expect(response.body).toEqual({
      users: users.slice(0, 20),
      nextOffset: 40,
    });
  });
  it("ends pagination after the last page", async () => {
    expect((await request(app).get(path).expect(200)).body).toEqual({
      users: [],
      nextOffset: null,
    });
  });
  it.each(["member", null])(
    "denies role %s before reading identities",
    async (role) => {
      mocks.role = role;
      await request(app).get(path).expect(403);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    "/audit/actors",
    "/audit/actors?org_id=invalid",
    `${path}&offset=-1`,
    `${path}&offset=1.5`,
    `${path}&offset=1000001`,
    `${path}&q=Alex&q=Jamie`,
  ])("rejects invalid input %s", async (url) => {
    await request(app).get(url).expect(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not expose database errors", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "private database detail" },
    });
    const response = await request(app).get(path).expect(500);
    expect(JSON.stringify(response.body)).not.toContain(
      "private database detail",
    );
  });
});
