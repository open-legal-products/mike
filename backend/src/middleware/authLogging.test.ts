import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  devLog: vi.fn(),
  assurance: vi.fn(),
}));
vi.mock("../lib/log", () => ({ devLog: mocks.devLog, isDev: true }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: {
      mfa: { getAuthenticatorAssuranceLevel: mocks.assurance },
      getUser: async () => ({ data: { user: { factors: [] } }, error: null }),
    },
  }),
}));
import { requireMfaIfEnrolled } from "./auth";

describe("OAuth callback auth diagnostics", () => {
  afterEach(() => vi.clearAllMocks());

  it.each(["aal1", "aal2"])("omits OAuth query credentials when the next level is %s", async (nextLevel) => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel }, error: null,
    });
    const app = express();
    app.use((_req, res, next) => {
      res.locals.token = "session-token";
      res.locals.userId = "test-user";
      next();
    });
    const path = "/user/integrations/google-drive/oauth/finish";
    app.get(path, requireMfaIfEnrolled, (_req, res) => res.json({ ok: true }));
    const response = await request(app).get(`${path}?code=private-oauth-code&state=private-oauth-state`);
    expect(response.status).toBe(nextLevel === "aal2" ? 403 : 200);
    expect(mocks.devLog).toHaveBeenCalled();
    for (const [, diagnostic] of mocks.devLog.mock.calls) {
      expect(diagnostic.path).toBe(path);
    }
    expect(JSON.stringify(mocks.devLog.mock.calls)).not.toContain("private-oauth");
  });
});
