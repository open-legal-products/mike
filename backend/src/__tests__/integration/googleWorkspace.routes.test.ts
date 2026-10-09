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
  settings: vi.fn(),
  tool: vi.fn(),
  driveSettings: vi.fn(),
  driveStatus: vi.fn(),
}));
vi.mock("../../lib/integrations/googleDrive", async (original) => ({
  ...(await original<typeof import("../../lib/integrations/googleDrive")>()),
  updateGoogleDriveSettings: mocks.driveSettings,
  getGoogleDriveStatus: mocks.driveStatus,
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
  cancelWorkspaceOAuth: mocks.cancel,
  disconnectWorkspace: mocks.disconnect,
  updateWorkspaceSettings: mocks.settings,
  setWorkspaceToolEnabled: mocks.tool,
}));
vi.mock("../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<
    typeof import("../../lib/integrations/googleWorkspace")
  >()),
  workspaceConnectorStatus: mocks.status,
  buildGoogleWorkspaceTools: vi.fn().mockResolvedValue([]),
  isGoogleWorkspaceTool: () => false,
}));
import { app } from "../../app";
import { ConnectorSetupError } from "../../lib/mcp/errors";
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
  it("validates and saves Drive's approval setting for the authenticated owner", async () => {
    mocks.driveStatus.mockResolvedValue({ writeEnabled: true, requireWriteApproval: true });
    expect((await request(app).patch("/user/integrations/google-drive").send({ requireWriteApproval: "yes" })).status).toBe(400);
    expect(mocks.driveSettings).not.toHaveBeenCalled();
    const response = await request(app).patch("/user/integrations/google-drive").send({ requireWriteApproval: true, readOnly: true, userId: "other-user" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ requireWriteApproval: true });
    expect(mocks.driveSettings).toHaveBeenCalledWith("owner", { enabled: undefined, requireWriteApproval: true, readOnly: true }, {});
  });
  it.each(["gmail", "google-calendar"])(
    "starts %s for the authenticated Mike user; the body cannot change the requested permissions",
    async (provider) => {
      mocks.start.mockResolvedValue({
        authorizationUrl: "https://accounts.google.com/auth",
      });
      expect(
        (
          await request(app)
            .post(`/user/integrations/${provider}/oauth/start`)
            .send({ write: false, scope: "anything" })
        ).status,
      ).toBe(200);
      expect(mocks.start).toHaveBeenCalledWith(
        {},
        "owner",
        provider,
        `http://localhost:3000/api/user/integrations/${provider}/oauth/callback`,
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
  it.each([
    ["post", "/user/integrations/gmail/oauth/start"],
    ["post", "/user/integrations/google-calendar/oauth/start"],
    ["patch", "/user/integrations/gmail"],
    ["patch", "/user/integrations/google-calendar/tools/google_calendar_create_event"],
  ] as const)("requires authentication and MFA for %s %s", async (method, path) => {
    mocks.auth = false;
    expect((await request(app)[method](path).send({ enabled: true })).status).toBe(401);
    mocks.auth = true;
    mocks.mfa = false;
    expect((await request(app)[method](path).send({ enabled: true })).status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.tool).not.toHaveBeenCalled();
  });
  it("saves connector settings for the authenticated owner and returns the fresh status", async () => {
    mocks.status.mockResolvedValue({ connected: true, requireWriteApproval: true });
    expect(
      (
        await request(app)
          .patch("/user/integrations/gmail")
          .send({ requireWriteApproval: "yes" })
      ).status,
    ).toBe(400);
    expect(mocks.settings).not.toHaveBeenCalled();
    const res = await request(app)
      .patch("/user/integrations/gmail")
      .send({ enabled: false, requireWriteApproval: true, readOnly: true, userId: "other" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requireWriteApproval: true });
    expect(mocks.settings).toHaveBeenCalledWith({}, "owner", "gmail", {
      enabled: false,
      requireWriteApproval: true,
      readOnly: true,
    });
  });
  it("switches only known tools of the addressed provider", async () => {
    mocks.status.mockResolvedValue({ connected: true });
    expect(
      (
        await request(app)
          .patch("/user/integrations/gmail/tools/google_calendar_create_event")
          .send({ enabled: false })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch("/user/integrations/gmail/tools/gmail_send")
          .send({ enabled: "no" })
      ).status,
    ).toBe(400);
    expect(mocks.tool).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .patch("/user/integrations/gmail/tools/gmail_send")
          .send({ enabled: false })
      ).status,
    ).toBe(200);
    expect(mocks.tool).toHaveBeenCalledWith({}, "owner", "gmail", "gmail_send", false);
  });
  it("no longer serves out-of-turn Google action approvals", async () => {
    expect((await request(app).get("/user/google-actions")).status).toBe(404);
    expect(
      (
        await request(app).post(
          "/user/google-actions/12345678-1234-1234-1234-123456789abc/approve",
        )
      ).status,
    ).toBe(404);
  });
  it("passes setup steps through with the connector_setup_required code", async () => {
    mocks.start.mockRejectedValue(
      new ConnectorSetupError("Gmail needs an OAuth client."),
    );
    const res = await request(app).post("/user/integrations/gmail/oauth/start");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "connector_setup_required",
      detail: "Gmail needs an OAuth client.",
    });
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


describe("Google read-only settings validation", () => {
  it.each(["google-drive", "gmail", "google-calendar"])("rejects a non-boolean mode for %s", async provider => {
    expect((await request(app).patch(`/user/integrations/${provider}`).send({ readOnly: "false" })).status).toBe(400);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.driveSettings).not.toHaveBeenCalled();
  });
});
