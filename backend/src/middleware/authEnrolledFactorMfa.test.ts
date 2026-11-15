// Login MFA is a per-user opt-in (user_profiles.mfa_on_login): by default an
// enrolled authenticator guards only sensitive actions, so a password-only
// (aal1) session still reads chats, documents and projects. An operator can
// turn on MFA_REQUIRE_FOR_ENROLLED_USERS to make every verified factor guard
// every authenticated route, answered with the same mfa_verification_required
// code the existing /verify-mfa flow already handles.
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  factors: [] as Array<{ factor_type: string; status: string }>,
  assurance: vi.fn(),
  loginPreference: vi.fn(),
}));
vi.mock("../lib/log", () => ({ devLog: vi.fn(), isDev: false }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => adminClient(),
}));

import { requireAuth } from "./auth";

const VERIFIED_TOTP = { factor_type: "totp", status: "verified" };

function adminClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: {
            id: "u1",
            email: "user@example.com",
            email_confirmed_at: "2026-01-01T00:00:00Z",
            factors: mocks.factors,
          },
        },
        error: null,
      }),
      mfa: { getAuthenticatorAssuranceLevel: mocks.assurance },
    },
    from: () => ({
      select: (columns: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            if (columns === "mfa_on_login") return mocks.loginPreference();
            if (columns === "email") return { data: { email: "user@example.com" }, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
  };
}

function app() {
  const server = express();
  const limiter = rateLimit({ windowMs: 60_000, limit: 100 });
  const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true });
  server.get("/projects", limiter, requireAuth, ok);
  server.get("/auth/mfa/factors", limiter, requireAuth, ok);
  server.post("/auth/mfa/challenge-and-verify", limiter, requireAuth, ok);
  return server;
}

const get = (path = "/projects") =>
  request(app()).get(path).set("Authorization", "Bearer session-token");

function atLevel(currentLevel: "aal1" | "aal2") {
  mocks.assurance.mockResolvedValue({
    data: { currentLevel, nextLevel: "aal2", currentAuthenticationMethods: [] },
    error: null,
  });
}

describe("an enrolled MFA factor and data reads", () => {
  beforeEach(() => {
    mocks.factors = [VERIFIED_TOTP];
    mocks.loginPreference.mockResolvedValue({ data: { mfa_on_login: false }, error: null });
    atLevel("aal1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("with MFA_REQUIRE_FOR_ENROLLED_USERS=true", () => {
    beforeEach(() => vi.stubEnv("MFA_REQUIRE_FOR_ENROLLED_USERS", "true"));

    it("refuses a password-only session of a user with a verified factor, though they never opted in", async () => {
      const res = await get();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        code: "mfa_verification_required",
        detail: "MFA verification required",
      });
    });

    it("lets the same user through once the session is aal2", async () => {
      atLevel("aal2");
      const res = await get();
      expect(res.status).toBe(200);
    });

    it("leaves a user with no verified factor alone, without an extra assurance lookup", async () => {
      mocks.factors = [{ factor_type: "totp", status: "unverified" }];
      const res = await get();
      expect(res.status).toBe(200);
      expect(mocks.assurance).not.toHaveBeenCalled();
    });

    it("keeps the MFA endpoints reachable at aal1 so the user can step up", async () => {
      expect((await get("/auth/mfa/factors")).status).toBe(200);
      const verify = await request(app())
        .post("/auth/mfa/challenge-and-verify")
        .set("Authorization", "Bearer session-token");
      expect(verify.status).toBe(200);
    });
  });

  it("keeps today's per-user opt-in when the switch is off", async () => {
    const res = await get();
    expect(res.status).toBe(200);
  });
});
