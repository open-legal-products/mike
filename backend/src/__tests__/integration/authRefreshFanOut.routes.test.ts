// A page load fans out many requests that carry one expired cookie session.
// Real requireAuth and @supabase/ssr against a stand-in GoTrue that rotates
// refresh tokens strictly: a token that has been used is refused.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/log", () => ({ devLog: vi.fn(), isDev: false }));

function jwt(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u1", exp, aud: "authenticated", role: "authenticated", session_id: "s1" })}.signature`;
}
const user = {
  id: "u1", aud: "authenticated", role: "authenticated", email: "fan-out@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
};

let refreshCalls = 0;
const usedRefreshTokens = new Set<string>();
const gotrue = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/auth/v1/token")) {
      refreshCalls++;
      const { refresh_token: token } = JSON.parse(body) as { refresh_token: string };
      if (usedRefreshTokens.has(token)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" }));
        return;
      }
      usedRefreshTokens.add(token);
      const exp = Math.floor(Date.now() / 1000) + 3600;
      res.end(JSON.stringify({ access_token: jwt(exp), refresh_token: `rotated-${refreshCalls}`, expires_in: 3600, expires_at: exp, token_type: "bearer", user }));
      return;
    }
    if (req.url?.startsWith("/auth/v1/user")) {
      res.end(JSON.stringify(user));
      return;
    }
    res.end("[]"); // PostgREST: no profile row, so no deletion and no login MFA
  });
});

let app: express.Express;
beforeAll(async () => {
  await new Promise<void>((resolve) => gotrue.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("SUPABASE_URL", `http://127.0.0.1:${(gotrue.address() as AddressInfo).port}`);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
  vi.stubEnv("NODE_ENV", "development");
  const { requireAuth } = await import("../../middleware/auth.js");
  app = express();
  // Mirrors app.ts, where the general limiter runs ahead of every
  // authenticated route. Its ceiling is far above this test's six requests,
  // so it never fires; it is here so the stack matches production.
  app.use(rateLimit({ windowMs: 60_000, max: 10_000, validate: false }));
  app.get("/projects", requireAuth, (_req, res) => { res.json({ ok: true }); });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => gotrue.close(() => resolve()));
});

describe("page-load fan-out with an expired cookie session", () => {
  it("refreshes once and authenticates every parallel request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expired = Math.floor(Date.now() / 1000) - 60;
    const session = { access_token: jwt(expired), refresh_token: "page-load-token", expires_in: 3600, expires_at: expired, token_type: "bearer", user };
    const cookie = `mike-session=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).get("/projects").set("Cookie", cookie)),
    );

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(refreshCalls).toBe(1);
    // Every response carries the one rotated session, none a cleared cookie.
    for (const res of responses) {
      const [written] = res.headers["set-cookie"] as unknown as string[];
      expect(written).toMatch(/^mike-session=base64-/);
      expect(written).not.toContain("Max-Age=0");
    }
  });
});
