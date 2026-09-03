import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authClient,
  createRequestSupabase,
  clearRequestAuthCookies,
  issueAuthHandoff,
  consumeAuthHandoff,
} = vi.hoisted(() => ({
  authClient: {
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signInWithOAuth: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      signOut: vi.fn(),
      setSession: vi.fn(),
      mfa: {
        verify: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
  },
  createRequestSupabase: vi.fn(),
  clearRequestAuthCookies: vi.fn(),
  issueAuthHandoff: vi.fn(),
  consumeAuthHandoff: vi.fn(),
}));

vi.mock("../../../lib/authSession", () => ({
  createRequestSupabase,
  clearRequestAuthCookies,
  publicAuthUser: (user: {
    id: string;
    email?: string;
    new_email?: string;
    app_metadata?: { provider?: string };
  }) => ({
    id: user.id,
    email: user.email ?? "",
    pendingEmail: user.new_email ?? null,
    createdWithGoogle: user.app_metadata?.provider === "google",
  }),
}));
vi.mock("../../../lib/authHandoff", () => ({
  issueAuthHandoff,
  consumeAuthHandoff,
}));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.authClient = authClient;
    res.locals.authSource = "cookie";
    next();
  },
}));

import { authRouter } from "../auth.routes";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);

const origin = "https://app.example.test";
const user = { id: "user-1", email: "lawyer@example.test" };
const session = { access_token: "server-only-token" };
const wordOrigin = "https://word.example.test";

describe("auth routes", () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = origin;
    process.env.NODE_ENV = "production";
    delete process.env.WORD_ADDIN_URL;
    createRequestSupabase.mockReset().mockReturnValue(authClient);
    clearRequestAuthCookies.mockReset();
    issueAuthHandoff.mockReset();
    consumeAuthHandoff.mockReset();
    for (const method of Object.values(authClient.auth)) {
      if (typeof method === "function") method.mockReset();
    }
    for (const method of Object.values(authClient.auth.mfa)) {
      method.mockReset();
    }
  });

  it("rejects an auth mutation from an untrusted origin", async () => {
    const response = await request(app)
      .post("/auth/login")
      .set("Origin", "https://attacker.example")
      .send({ email: "lawyer@example.test", password: "correct horse" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("untrusted_origin");
    expect(createRequestSupabase).not.toHaveBeenCalled();
  });

  it("establishes a server session without returning tokens", async () => {
    authClient.auth.signInWithPassword.mockResolvedValue({
      data: { user, session },
      error: null,
    });

    const response = await request(app)
      .post("/auth/login")
      .set("Origin", origin)
      .send({ email: user.email, password: "correct horse" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({
      user: {
        id: user.id,
        email: user.email,
        pendingEmail: null,
        createdWithGoogle: false,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("server-only-token");
  });

  it("keeps OAuth redirects on the requesting client origin", async () => {
    authClient.auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.test/authorize" },
      error: null,
    });

    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({
        provider: "google",
        callbackPath: "/oauth-dialog.html",
        next: "//attacker.example/steal",
      });

    expect(response.status).toBe(200);
    expect(authClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo:
          "https://app.example.test/oauth-dialog.html?next=%2Fonboarding%2Fprofile",
        skipBrowserRedirect: true,
      },
    });
  });

  it("does not reveal whether a password-reset email exists", async () => {
    authClient.auth.resetPasswordForEmail.mockRejectedValue(
      new Error("account not found"),
    );

    const response = await request(app)
      .post("/auth/password-reset")
      .set("Origin", origin)
      .send({ email: "unknown@example.test" });

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
  });

  it("always clears local cookies during logout", async () => {
    authClient.auth.signOut.mockRejectedValue(
      new Error("upstream unavailable"),
    );

    const response = await request(app)
      .post("/auth/logout")
      .set("Origin", origin)
      .send({ scope: "local" });

    expect(response.status).toBe(204);
    expect(clearRequestAuthCookies).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "/auth/mfa/verify",
      "verify",
      { challengeId: "22222222-2222-4222-8222-222222222222" },
    ],
    ["/auth/mfa/challenge-and-verify", "challengeAndVerify", {}],
  ] as const)(
    "does not expose tokens from %s",
    async (path, method, extraBody) => {
      authClient.auth.mfa[method].mockResolvedValue({
        data: {
          access_token: "mfa-access-token",
          refresh_token: "mfa-refresh-token",
          user,
        },
        error: null,
      });

      const response = await request(app)
        .post(path)
        .set("Origin", origin)
        .send({
          factorId: "11111111-1111-4111-8111-111111111111",
          code: "123456",
          ...extraBody,
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        user: {
          id: user.id,
          email: user.email,
          pendingEmail: null,
          createdWithGoogle: false,
        },
      });
      expect(JSON.stringify(response.body)).not.toContain("mfa-access-token");
      expect(JSON.stringify(response.body)).not.toContain("mfa-refresh-token");
    },
  );

  it("exchanges Word OAuth sessions for an opaque handoff ticket", async () => {
    process.env.WORD_ADDIN_URL = wordOrigin;
    authClient.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user, session },
      error: null,
    });
    issueAuthHandoff.mockResolvedValue("a".repeat(43));

    const response = await request(app)
      .post("/auth/exchange")
      .set("Origin", wordOrigin)
      .send({ code: "oauth-code", handoffRequestId: "request-id-123456" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handoffTicket: "a".repeat(43) });
    expect(JSON.stringify(response.body)).not.toContain("server-only-token");
    expect(issueAuthHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        requestId: "request-id-123456",
        origin: wordOrigin,
        session,
      }),
    );
  });

  it("redeems a Word handoff into an HttpOnly session without returning tokens", async () => {
    process.env.WORD_ADDIN_URL = wordOrigin;
    consumeAuthHandoff.mockResolvedValue({
      userId: user.id,
      accessToken: "handoff-access-token",
      refreshToken: "handoff-refresh-token",
    });
    authClient.auth.setSession.mockResolvedValue({
      data: { user, session },
      error: null,
    });

    const response = await request(app)
      .post("/auth/handoff")
      .set("Origin", wordOrigin)
      .send({ ticket: "b".repeat(43), requestId: "request-id-123456" });

    expect(response.status).toBe(200);
    expect(authClient.auth.setSession).toHaveBeenCalledWith({
      access_token: "handoff-access-token",
      refresh_token: "handoff-refresh-token",
    });
    expect(response.body).toEqual({
      user: {
        id: user.id,
        email: user.email,
        pendingEmail: null,
        createdWithGoogle: false,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("handoff-access-token");
    expect(JSON.stringify(response.body)).not.toContain(
      "handoff-refresh-token",
    );
  });
});
