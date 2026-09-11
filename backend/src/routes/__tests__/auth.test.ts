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
      signInWithSSO: vi.fn(),
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

vi.mock("../../lib/authSession", () => ({
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
vi.mock("../../lib/authHandoff", () => ({
  issueAuthHandoff,
  consumeAuthHandoff,
}));
vi.mock("../../middleware/auth", () => ({
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

import { authRouter } from "../auth";

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
    for (const key of ["SSO_ENABLED", "SSO_ALLOWED_DOMAINS"])
      delete process.env[key];
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

  it("disables SSO initiation by default", async () => {
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({ provider: "sso", email: "lawyer@example.com" });
    expect(response.status).toBe(403);
    expect(createRequestSupabase).not.toHaveBeenCalled();
  });

  it("extracts a normalized email domain and uses the shared callback", async () => {
    process.env.SSO_ENABLED = "true";
    process.env.SSO_ALLOWED_DOMAINS = "example.com, other.example";
    authClient.auth.signInWithSSO.mockResolvedValue({
      data: { url: "https://idp.example/saml" },
      error: null,
    });
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({
        provider: "sso",
        email: " Lawyer@Example.COM ",
        next: "//attacker.example",
        callbackPath: "https://attacker.example",
      });
    expect(response.body).toEqual({ url: "https://idp.example/saml" });
    expect(authClient.auth.signInWithSSO).toHaveBeenCalledWith({
      domain: "example.com",
      options: {
        redirectTo: `${origin}/auth/callback?next=%2Fonboarding%2Fprofile`,
        skipBrowserRedirect: true,
      },
    });
  });

  it("requires a company email and permits an allowed email domain", async () => {
    process.env.SSO_ENABLED = "true";
    const missing = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({ provider: "sso" });
    expect(missing.body.code).toBe("invalid_request");
    process.env.SSO_ALLOWED_DOMAINS = "default.example,other.example";
    authClient.auth.signInWithSSO.mockResolvedValue({
      data: { url: "https://idp.example/saml" },
      error: null,
    });
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({
        provider: "sso",
        email: " Lawyer@OTHER.EXAMPLE ",
        next: "/projects",
      });
    expect(response.status).toBe(200);
    expect(authClient.auth.signInWithSSO).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "other.example",
        options: expect.objectContaining({
          redirectTo: `${origin}/auth/callback?next=%2Fprojects`,
        }),
      }),
    );
  });

  it.each([
    "",
    "example.com",
    "https://example.com",
    "*.example.com",
    "user@example.com:443",
    "user@-bad.example",
    "user@example..com",
    123,
    null,
    `user@${"a".repeat(64)}.com`,
  ])("rejects invalid SSO email %s", async (email) => {
    process.env.SSO_ENABLED = "true";
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({ provider: "sso", email });
    expect(response.status).toBe(400);
    expect(createRequestSupabase).not.toHaveBeenCalled();
  });

  it("enforces exact domain allowlisting and trusted origins", async () => {
    process.env.SSO_ENABLED = "true";
    process.env.SSO_ALLOWED_DOMAINS = "example.com";
    for (const email of [
      "lawyer@other.example",
      "lawyer@sub.example.com",
      "lawyer@example.com.evil.test",
    ]) {
      const response = await request(app)
        .post("/auth/oauth")
        .set("Origin", origin)
        .send({ provider: "sso", email });
      expect(response.body.code).toBe("sso_domain_not_allowed");
    }
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", "https://attacker.example")
      .send({ provider: "sso", email: "lawyer@example.com" });
    expect(response.status).toBe(403);
    expect(createRequestSupabase).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid domain allowlist", async () => {
    process.env.SSO_ENABLED = "true";
    process.env.SSO_ALLOWED_DOMAINS = "example.com,,other.example";
    const response = await request(app)
      .post("/auth/oauth")
      .set("Origin", origin)
      .send({ provider: "sso", email: "lawyer@example.com" });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal_error");
    expect(createRequestSupabase).not.toHaveBeenCalled();
  });

  it.each([400, 404, 429, 500])(
    "sanitizes provider errors (%s)",
    async (status) => {
      process.env.SSO_ENABLED = "true";
      authClient.auth.signInWithSSO.mockResolvedValue({
        data: null,
        error: { status, message: "private provider diagnostics" },
      });
      const response = await request(app)
        .post("/auth/oauth")
        .set("Origin", origin)
        .send({ provider: "sso", email: "lawyer@example.com" });
      expect(response.status).toBe(status < 500 ? 400 : 500);
      expect(response.text).not.toContain("private provider diagnostics");
    },
  );

  it("sanitizes thrown failures and missing redirects", async () => {
    process.env.SSO_ENABLED = "true";
    authClient.auth.signInWithSSO.mockRejectedValueOnce(
      new Error("private diagnostics"),
    );
    authClient.auth.signInWithSSO.mockResolvedValueOnce({
      data: {},
      error: null,
    });
    for (let i = 0; i < 2; i++) {
      const response = await request(app)
        .post("/auth/oauth")
        .set("Origin", origin)
        .send({ provider: "sso", email: "lawyer@example.com" });
      expect(response.status).toBe(500);
      expect(response.text).not.toContain("private diagnostics");
    }
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
