import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Response } from "express";
const mocks = vi.hoisted(() => ({
  auth: true,
  mfa: true,
  start: vi.fn(),
  complete: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  disconnect: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (_r: unknown, res: Response, next: () => void) => {
    if (!mocks.auth) return void res.status(401).end();
    res.locals.userId = "owner";
    next();
  },
  requireMfaIfEnrolled: (_r: unknown, res: Response, next: () => void) => {
    if (!mocks.mfa)
      return void res.status(403).json({ code: "mfa_verification_required" });
    next();
  },
}));
vi.mock("../../lib/integrations/googleWorkspaceAuth", async (original) => ({
  ...(await original<
    typeof import("../../lib/integrations/googleWorkspaceAuth")
  >()),
  startWorkspaceOAuth: mocks.start,
  completeWorkspaceOAuth: mocks.complete,
  workspaceStatus: mocks.status,
  cancelWorkspaceOAuth: mocks.cancel,
  disconnectWorkspace: mocks.disconnect,
}));
vi.mock("../../lib/integrations/googleWorkspace", () => ({
  listWorkspaceActions: mocks.list,
  approveWorkspaceAction: mocks.approve,
  rejectWorkspaceAction: mocks.reject,
  buildGoogleWorkspaceTools: vi.fn().mockResolvedValue([]),
  isGoogleWorkspaceTool: () => false,
}));
import { app } from "../../app";
const action = "12345678-1234-1234-1234-123456789abc";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = true;
  mocks.mfa = true;
  vi.stubEnv("API_PUBLIC_URL", "http://localhost:3000/api");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Google Workspace routes", () => {
  it.each(["gmail", "google-calendar"])(
    "defaults %s to read-only and uses authenticated Mike user",
    async (provider) => {
      mocks.start.mockResolvedValue({
        authorizationUrl: "https://accounts.google.com/auth",
      });
      expect(
        (
          await request(app)
            .post(`/user/integrations/${provider}/oauth/start`)
            .send({})
        ).status,
      ).toBe(200);
      expect(mocks.start).toHaveBeenCalledWith(
        {},
        "owner",
        provider,
        `http://localhost:3000/api/user/integrations/${provider}/oauth/callback`,
        false,
      );
    },
  );
  it.each(["google-drive", "gmail", "google-calendar"])(
    "relays %s callbacks to the fixed frontend and rejects unauthenticated completion",
    async (provider) => {
      vi.stubEnv("FRONTEND_URL", "https://app.mike.test");
      mocks.auth = false;
      const relay = await request(app)
        .get(`/user/integrations/${provider}/oauth/callback`)
        .query({ state: "s", code: "c", redirect_uri: "https://attacker.test" })
        .set("Host", "attacker.test");
      expect(relay.status).toBe(303);
      expect(relay.headers.location).toBe(
        `https://app.mike.test/api/user/integrations/${provider}/oauth/finish?state=s&code=c`,
      );
      expect(relay.headers["cache-control"]).toBe("no-store");
      expect(relay.headers["referrer-policy"]).toBe("no-referrer");
      const finish = `/user/integrations/${provider}/oauth/finish?state=s&code=c`;
      expect((await request(app).get(finish)).status).toBe(401);
      mocks.auth = true;
      mocks.mfa = false;
      expect((await request(app).get(finish)).status).toBe(403);
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );
  it.each(["gmail", "google-calendar"])(
    "binds %s completion to the authenticated user",
    async (provider) => {
      mocks.complete.mockResolvedValue(undefined);
      const res = await request(app).get(
        `/user/integrations/${provider}/oauth/finish?state=s&code=c`,
      );
      expect(res.status).toBe(200);
      expect(mocks.complete).toHaveBeenCalledWith(
        {},
        "owner",
        provider,
        "s",
        "c",
      );
    },
  );
  it("only enables writes through an explicit boolean", async () => {
    expect(
      (
        await request(app)
          .post("/user/integrations/gmail/oauth/start")
          .send({ write: "true" })
      ).status,
    ).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    mocks.start.mockResolvedValue({ authorizationUrl: "url" });
    await request(app)
      .post("/user/integrations/gmail/oauth/start")
      .send({ write: true });
    expect(mocks.start.mock.calls[0].at(-1)).toBe(true);
  });
  it.each([
    "/user/integrations/gmail/oauth/start",
    "/user/integrations/google-calendar/oauth/start",
    `/user/google-actions/${action}/approve`,
    `/user/google-actions/${action}/reject`,
  ])("requires authentication and MFA for %s", async (path) => {
    mocks.auth = false;
    expect((await request(app).post(path)).status).toBe(401);
    mocks.auth = true;
    mocks.mfa = false;
    expect((await request(app).post(path)).status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not let approval replace the reviewed payload or user ID", async () => {
    expect(
      (
        await request(app)
          .post(`/user/google-actions/${action}/approve`)
          .send({ userId: "other", payload: { to: "attacker" } })
      ).status,
    ).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
    mocks.approve.mockResolvedValue({ status: "succeeded" });
    expect(
      (await request(app).post(`/user/google-actions/${action}/approve`))
        .status,
    ).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith({}, "owner", action);
  });
  it("lists only through the authenticated owner service and rejects malformed IDs", async () => {
    mocks.list.mockResolvedValue([]);
    expect((await request(app).get("/user/google-actions")).body).toEqual({
      actions: [],
    });
    expect(mocks.list).toHaveBeenCalledWith({}, "owner");
    expect(
      (await request(app).post("/user/google-actions/not-an-id/approve"))
        .status,
    ).toBe(400);
  });
  it("sanitizes provider and database errors", async () => {
    mocks.start.mockRejectedValue(new Error("secret token and stack"));
    const start = await request(app).post(
      "/user/integrations/gmail/oauth/start",
    );
    expect(JSON.stringify(start.body)).not.toContain("secret");
    mocks.complete.mockRejectedValue(new Error("secret token"));
    const callback = await request(app).get(
      "/user/integrations/gmail/oauth/finish?state=s&code=c",
    );
    expect(callback.status).toBe(400);
    expect(callback.text).not.toContain("secret");
    expect(callback.headers["content-security-policy"]).toContain("nonce-");
  });
});
