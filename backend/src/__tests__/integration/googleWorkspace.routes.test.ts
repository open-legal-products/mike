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
  db: {} as unknown,
}));
vi.mock("../../lib/integrations/googleDrive", async (original) => ({
  ...(await original<typeof import("../../lib/integrations/googleDrive")>()),
  updateGoogleDriveSettings: mocks.driveSettings,
  getGoogleDriveStatus: mocks.driveStatus,
}));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => mocks.db }));
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
import { GoogleWorkspaceUnavailableError } from "../../lib/integrations/googleWorkspaceAuth";
import { encryptString } from "../../lib/mcp/client";
import { driveDb } from "../../lib/integrations/__tests__/googleDriveDb";

// Connector routes act on the caller's Personal connections unless
// `?workspace=` names an organization they belong to.
const PERSONAL = { userId: "owner", orgId: null };
const FIRM = "11111111-1111-4111-8111-111111111111";

/** Answers the two reads resolveWorkspaceFilter makes. */
function membershipDb(member: boolean) {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data:
            table === "org_members"
              ? member
                ? { org_id: FIRM }
                : null
              : { kind: "team" },
          error: null,
        }),
      };
      return builder;
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.db = {};
  mocks.auth = true;
  mocks.mfa = true;
  vi.stubEnv("API_PUBLIC_URL", "http://localhost:3000/api");
  // The app loads backend/.env; a developer's switched-off services must not
  // decide these tests.
  vi.stubEnv("GOOGLE_WORKSPACE_DISABLED_PROVIDERS", "");
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
    expect(mocks.driveSettings).toHaveBeenCalledWith(PERSONAL, { enabled: undefined, requireWriteApproval: true, readOnly: true }, {});
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
        PERSONAL,
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
    expect(mocks.settings).toHaveBeenCalledWith({}, PERSONAL, "gmail", {
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
    expect(mocks.tool).toHaveBeenCalledWith({}, PERSONAL, "gmail", "gmail_send", false);
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
  it("refuses to start consent for a service not offered to the user", async () => {
    // startWorkspaceOAuth checks the user's flags itself, before it writes
    // any state; the route turns that refusal into 404 connector_unavailable.
    mocks.start.mockRejectedValueOnce(
      new GoogleWorkspaceUnavailableError("Gmail is not offered on this Mike server."),
    );
    const res = await request(app).post("/user/integrations/gmail/oauth/start");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      code: "connector_unavailable",
      detail: "Gmail is not offered on this Mike server.",
    });
    mocks.start.mockResolvedValue({ authorizationUrl: "https://accounts.google.com/x" });
    const calendar = await request(app).post(
      "/user/integrations/google-calendar/oauth/start",
    );
    expect(calendar.status).toBe(200);
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

describe("Google Drive picker session", () => {
  const pickerSession = () =>
    request(app).post("/user/integrations/google-drive/picker-session");
  const connected = (overrides: Record<string, unknown> = {}) => {
    vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "test-encryption-secret");
    const access = encryptString("access-token-1");
    const refresh = encryptString("refresh-token-1");
    mocks.db = driveDb({
      tokenRow: {
        user_id: "owner",
        grant_id: "grant-1",
        encrypted_access_token: access.encrypted,
        access_token_iv: access.iv,
        access_token_tag: access.tag,
        encrypted_refresh_token: refresh.encrypted,
        refresh_token_iv: refresh.iv,
        refresh_token_tag: refresh.tag,
        scope: "openid email https://www.googleapis.com/auth/drive.file",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        ...overrides,
      },
    }).db;
  };
  beforeEach(() => {
    vi.stubEnv("GOOGLE_DRIVE_PICKER_API_KEY", "picker-key");
    vi.stubEnv("GOOGLE_DRIVE_PICKER_APP_ID", "123456789");
  });

  it("requires a signed-in user", async () => {
    mocks.auth = false;
    expect((await pickerSession()).status).toBe(401);
  });

  it("answers 404 when the server has no Picker key or app id", async () => {
    connected();
    vi.stubEnv("GOOGLE_DRIVE_PICKER_APP_ID", "");
    const res = await pickerSession();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("google_drive_picker_unavailable");
  });

  it("answers 404 when the operator switched Drive off, without a token", async () => {
    connected();
    vi.stubEnv("GOOGLE_WORKSPACE_DISABLED_PROVIDERS", "google-drive");
    const res = await pickerSession();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      code: "connector_unavailable",
      detail: "Google Drive is not offered on this Mike server.",
    });
  });

  it("answers 409 when Drive is not connected or is turned off", async () => {
    mocks.db = driveDb().db;
    const missing = await pickerSession();
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("google_drive_auth_required");
    connected({ enabled: false });
    expect((await pickerSession()).status).toBe(409);
  });

  it("answers 409 for a connection made with whole-Drive access, without a token", async () => {
    connected({ scope: "openid email https://www.googleapis.com/auth/drive" });
    const res = await pickerSession();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("google_drive_picker_reconnect");
    expect(JSON.stringify(res.body)).not.toContain("access-token-1");
  });

  it("returns a short-lived token for the Picker and never the refresh token", async () => {
    connected();
    const res = await pickerSession();
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      accessToken: "access-token-1",
      expiresAt: expect.any(String),
      appId: "123456789",
      developerKey: "picker-key",
    });
    expect(JSON.stringify(res.body)).not.toContain("refresh-token-1");
  });

  it("acts on the connections of the organization ?workspace= names", async () => {
    mocks.db = membershipDb(true);
    mocks.status.mockResolvedValue({ connected: false });
    const res = await request(app).get(`/user/integrations/gmail?workspace=${FIRM}`);
    expect(res.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith(
      mocks.db,
      { userId: "owner", orgId: FIRM },
      "gmail",
    );
  });

  it("refuses a workspace the caller does not belong to, without touching connections", async () => {
    mocks.db = membershipDb(false);
    for (const res of [
      await request(app).get(`/user/integrations/gmail?workspace=${FIRM}`),
      await request(app)
        .patch(`/user/integrations/google-drive?workspace=${FIRM}`)
        .send({ enabled: false }),
      await request(app).get(`/user/mcp-connectors?workspace=${FIRM}`),
      await request(app).get(`/user/integrations/courtlistener?workspace=${FIRM}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "workspace_not_found" });
    }
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.driveSettings).not.toHaveBeenCalled();
  });
});
