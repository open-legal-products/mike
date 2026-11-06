// A page load fans out many requests that carry one expired cookie session.
// Real requireAuth and @supabase/ssr against a stand-in GoTrue that behaves
// like GoTrue v2.189 on refresh: a token whose refresh is still running is
// refused with 409 "Too many concurrent token refresh requests"
// (MIKE-BACKEND-8D), a token that has been used is refused with 400
// refresh_token_already_used, and some tokens make it fail the way an outage
// or a GoTrue bug would. The outage and GoTrue-500 cases use a live access
// token, so the failure comes from /user: on the refresh path auth-js retries
// a retryable failure with backoff for up to 30 s before giving up.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/log", () => ({ devLog: vi.fn(), isDev: false }));

function jwt(exp: number, signature = "signature"): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u1", exp, aud: "authenticated", role: "authenticated", session_id: "s1" })}.${signature}`;
}
const user = {
  id: "u1", aud: "authenticated", role: "authenticated", email: "fan-out@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
};

// How long the stand-in takes to rotate a token: long enough that a page
// load's parallel requests all arrive while the first refresh is running.
const REFRESH_LATENCY_MS = 100;

let refreshCalls = 0;
const refreshAnswers: number[] = [];
const refreshing = new Set<string>();
const usedRefreshTokens = new Set<string>();
const gotrue = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const answer = (status: number, payload: object) => {
      refreshAnswers.push(status);
      res.statusCode = status;
      res.end(JSON.stringify(payload));
    };
    if (req.url?.startsWith("/auth/v1/token")) {
      refreshCalls++;
      const { refresh_token: token } = JSON.parse(body) as { refresh_token: string };
      if (refreshing.has(token)) {
        answer(409, { code: "conflict", error_code: "conflict", msg: "Too many concurrent token refresh requests on the same session or refresh token" });
        return;
      }
      if (usedRefreshTokens.has(token)) {
        answer(400, { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
        return;
      }
      refreshing.add(token);
      const rotated = `rotated-${refreshCalls}`;
      setTimeout(() => {
        refreshing.delete(token);
        usedRefreshTokens.add(token);
        const exp = Math.floor(Date.now() / 1000) + 3600;
        answer(200, { access_token: jwt(exp), refresh_token: rotated, expires_in: 3600, expires_at: exp, token_type: "bearer", user });
      }, REFRESH_LATENCY_MS);
      return;
    }
    if (req.url?.startsWith("/auth/v1/user")) {
      const authorization = req.headers.authorization ?? "";
      if (authorization.endsWith(".outage")) {
        res.statusCode = 503;
        res.end(JSON.stringify({ msg: "upstream connect error" }));
        return;
      }
      if (authorization.endsWith(".broken")) {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: 500, msg: "Database error querying schema" }));
        return;
      }
      res.end(JSON.stringify(user));
      return;
    }
    res.end("[]"); // PostgREST: no profile row, so no deletion and no login MFA
  });
});

/**
 * One API process: its own module graph, so its own requireAuth, cookie
 * client factory and refresh single-flight. Two of these are two replicas
 * behind a load balancer.
 */
async function apiProcess(): Promise<express.Express> {
  vi.resetModules();
  const { requireAuth } = await import("../../middleware/auth.js");
  const server = express();
  // Mirrors app.ts, where the general limiter runs ahead of every
  // authenticated route. Its ceiling is far above this test's requests, so
  // it never fires; it is here so the stack matches production.
  server.use(rateLimit({ windowMs: 60_000, max: 10_000, validate: false }));
  server.get("/projects", requireAuth, (_req, res) => { res.json({ ok: true }); });
  return server;
}

function expiredSessionCookie(refreshToken: string): string {
  const expired = Math.floor(Date.now() / 1000) - 60;
  const session = { access_token: jwt(expired), refresh_token: refreshToken, expires_in: 3600, expires_at: expired, token_type: "bearer", user };
  return `mike-session=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function liveSessionCookie(signature: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = { access_token: jwt(exp, signature), refresh_token: "live-token", expires_in: 3600, expires_at: exp, token_type: "bearer", user };
  return `mike-session=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function writtenCookies(res: request.Response): string[] {
  return (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
}

const pageLoad = (server: express.Express, cookie: string, count: number) =>
  Promise.all(Array.from({ length: count }, () => request(server).get("/projects").set("Cookie", cookie)));

let app: express.Express;
beforeAll(async () => {
  await new Promise<void>((resolve) => gotrue.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("SUPABASE_URL", `http://127.0.0.1:${(gotrue.address() as AddressInfo).port}`);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
  vi.stubEnv("NODE_ENV", "development");
  app = await apiProcess();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => gotrue.close(() => resolve()));
});
beforeEach(() => {
  refreshCalls = 0;
  refreshAnswers.length = 0;
  // sendInternalError logs the 5xx cases; keep the output readable.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("page-load fan-out with an expired cookie session", () => {
  it("refreshes once and authenticates every parallel request", async () => {
    const responses = await pageLoad(app, expiredSessionCookie("page-load-token"), 6);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(refreshCalls).toBe(1);
    // Every response carries the one rotated session, none a cleared cookie.
    for (const res of responses) {
      const [written] = writtenCookies(res);
      expect(written).toMatch(/^mike-session=base64-/);
      expect(written).not.toContain("Max-Age=0");
    }
  });

  it("does not hand a finished refresh to a request that arrives later", async () => {
    const cookie = expiredSessionCookie("late-straggler-token");
    const [first] = await pageLoad(app, cookie, 1);
    expect(first!.status).toBe(200);

    // The same old token after the refresh has finished goes to GoTrue,
    // which decides (this stand-in refuses it as already used; real GoTrue
    // may still accept it inside its reuse interval). The process does not
    // replay the rotated session from memory.
    const late = await request(app).get("/projects").set("Cookie", cookie);
    expect(refreshCalls).toBe(2);
    expect(late.status).toBe(401);
    expect(late.body).toEqual({ code: "session_expired", detail: "Invalid or expired session" });
  });

  it("answers two replicas sharing one session with 200 or a clean 401, never a 500", async () => {
    const replicaA = await apiProcess();
    const replicaB = await apiProcess();
    const cookie = expiredSessionCookie("two-replica-token");

    const [onA, onB] = await Promise.all([pageLoad(replicaA, cookie, 3), pageLoad(replicaB, cookie, 3)]);

    // Each process refreshes once. GoTrue rotates for whichever arrives
    // first and refuses the other while that is still running (409).
    expect(refreshCalls).toBe(2);
    expect([...refreshAnswers].sort()).toEqual([200, 409]);
    const outcomes = [onA, onB].map((responses) => responses.map((res) => res.status));
    expect(outcomes).toContainEqual([200, 200, 200]);
    expect(outcomes).toContainEqual([401, 401, 401]);
    for (const res of [...onA, ...onB]) {
      if (res.status === 401) {
        expect(res.body).toEqual({ code: "session_expired", detail: "Invalid or expired session" });
      }
    }
  });
});

describe("a cookie session GoTrue cannot vouch for", () => {
  it("answers a refused refresh token 401 session_expired and clears the cookie", async () => {
    usedRefreshTokens.add("revoked-token");

    const res = await request(app).get("/projects").set("Cookie", expiredSessionCookie("revoked-token"));

    expect(refreshAnswers).toEqual([400]);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "session_expired", detail: "Invalid or expired session" });
    expect(writtenCookies(res).some((cookie) => cookie.startsWith("mike-session=") && cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("answers GoTrue being unreachable 503 and keeps the session cookie", async () => {
    const res = await request(app).get("/projects").set("Cookie", liveSessionCookie("outage"));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "upstream_unavailable" });
    expect(res.headers["retry-after"]).toBe("5");
    expect(writtenCookies(res).join("\n")).not.toContain("Max-Age=0");
  });

  it("answers a GoTrue 500 as a server failure, not a sign-out", async () => {
    const res = await request(app).get("/projects").set("Cookie", liveSessionCookie("broken"));

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error" });
    expect(writtenCookies(res).join("\n")).not.toContain("Max-Age=0");
  });
});
