// PATCH /auth/password replaces the credential that protects the account. A
// user who enrolled an authenticator must prove it (an aal2 session) before
// a password-only session, or a stolen session cookie, can change it.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateUser: vi.fn(),
  assurance: vi.fn(),
}));
const authClient = { auth: { updateUser: mocks.updateUser } };

vi.mock("../../../lib/log", () => ({ devLog: vi.fn(), isDev: false }));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: { mfa: { getAuthenticatorAssuranceLevel: mocks.assurance } },
  }),
}));
vi.mock("../../../lib/authSession", () => ({
  createRequestSupabase: vi.fn(),
  clearRequestAuthCookies: vi.fn(),
  publicAuthUser: (user: { id: string }) => ({ id: user.id }),
}));
// The real requireMfaIfEnrolled runs; only session establishment is faked.
vi.mock("../../../middleware/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.authClient = authClient;
    res.locals.authSource = "cookie";
    res.locals.token = "session-token";
    res.locals.userId = "user-1";
    next();
  },
}));

import { authRouter } from "../auth.routes";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);

const origin = "https://app.example.test";
const changePassword = () =>
  request(app)
    .patch("/auth/password")
    .set("Origin", origin)
    .send({ password: "a brand new passphrase" });

function assurance(currentLevel: "aal1" | "aal2", nextLevel: "aal1" | "aal2") {
  mocks.assurance.mockResolvedValue({
    data: { currentLevel, nextLevel, currentAuthenticationMethods: [] },
    error: null,
  });
}

describe("password change re-authentication", () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = origin;
    vi.clearAllMocks();
    mocks.updateUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  });

  it("refuses a password-only session of a user with an enrolled factor", async () => {
    assurance("aal1", "aal2");
    const res = await changePassword();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("mfa_verification_required");
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("changes it once the session is aal2", async () => {
    assurance("aal2", "aal2");
    const res = await changePassword();
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "a brand new passphrase" });
  });

  it("leaves a user with no factor to change it as before", async () => {
    assurance("aal1", "aal1");
    const res = await changePassword();
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledOnce();
  });
});
