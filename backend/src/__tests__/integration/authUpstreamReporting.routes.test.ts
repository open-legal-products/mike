// MIK-125: one GoTrue outage used to file three Sentry issues per auth route
// (authError's reportError, the response sanitizer's reportMessage, and the
// console bridge's copy of the sanitizer's console.error). This drives the
// real auth router behind the real sanitizer, with a real Supabase client
// pointed at a closed port and a real Sentry client whose transport records
// every event, so each of the three paths is counted where it is produced.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSentryForTests, scrubEvent } from "../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../lib/observability/sentryPrivacy";
import { requireAuth } from "../../middleware/auth";
import { protectInternalErrorResponses } from "../../middleware/internalErrorResponse";
import { authRouter } from "../../modules/auth/auth.routes";
import { resetUpstreamOutagesForTests } from "../../lib/upstreamOutage";

const origin = "https://app.example.test";
const saved: Record<string, string | undefined> = {};
const ENV = {
  FRONTEND_URL: origin,
  // Port 9 (discard) is closed on CI runners and dev machines: auth-js gets
  // ECONNREFUSED and turns it into an AuthRetryableFetchError (status 0).
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SECRET_KEY: "test-secret-key",
};

const events: Sentry.ErrorEvent[] = [];

// A GoTrue that is up and failing on something of ours, the way a broken
// auth.users trigger or a missing migration makes it answer sign-up.
const brokenGoTrue = http.createServer((_req, res) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 500, msg: "Database error saving new user" }));
});

// A GoTrue (and PostgREST) that is back: it knows the bearer token's user,
// and every table read finds nothing.
const healthySupabase = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url?.startsWith("/auth/v1/user")) {
    res.end(JSON.stringify({ id: "u1", aud: "authenticated", email: "lawyer@example.test" }));
  } else {
    res.end("[]");
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => brokenGoTrue.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => healthySupabase.listen(0, "127.0.0.1", resolve));
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(async () => {
  await new Promise<void>((resolve) => brokenGoTrue.close(() => resolve()));
  await new Promise<void>((resolve) => healthySupabase.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  events.length = 0;
  resetUpstreamOutagesForTests();
  resetSentryForTests("community", { initialized: true });
  Sentry.init({
    dsn: "https://test@sentry.invalid/1",
    defaultIntegrations: false,
    integrations: [
      privacyBoundaryIntegration(),
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
    ],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  // Keep the test output quiet; the bridge still sees console.error calls
  // because captureConsoleIntegration wraps the (spied) method.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Sentry.close();
  resetSentryForTests("community");
  vi.restoreAllMocks();
});

function app() {
  const server = express();
  server.use((_req, res, next) => {
    res.locals.requestId = "req-auth-outage";
    next();
  });
  server.use(protectInternalErrorResponses);
  server.use(express.json());
  server.use("/auth", authRouter);
  // The real app rate-limits every auth-guarded route (app.ts); CodeQL's
  // js/missing-rate-limiting query expects the same in front of this one.
  const limiter = rateLimit({ windowMs: 60_000, limit: 1_000 });
  server.get("/projects", limiter, requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
  return server;
}

it("answers an unreachable GoTrue with 503 upstream_unavailable and files exactly one event", async () => {
  const res = await request(app())
    .post("/auth/login")
    .set("Origin", origin)
    .send({ email: "lawyer@example.test", password: "correct horse battery" });
  await Sentry.flush(2000);

  expect(res.status).toBe(503);
  expect(res.body).toEqual({
    code: "upstream_unavailable",
    detail: "The server is temporarily unreachable. Please try again shortly.",
    request_id: "req-auth-outage",
  });

  const exceptions = events.filter((event) => event.logger !== "console" && event.exception);
  const messages = events.filter((event) => event.logger !== "console" && !event.exception);
  const bridged = events.filter((event) => event.logger === "console");
  expect({ exceptions: exceptions.length, messages: messages.length, bridged: bridged.length })
    .toEqual({ exceptions: 1, messages: 0, bridged: 0 });
  expect(exceptions[0]!.tags).toMatchObject({
    operation: "auth.signin",
    error_kind: "auth.supabase_unavailable",
    http_status: 503,
  });
});

it("keeps a GoTrue 500 a reported 500, not an outage the user should wait out", async () => {
  const { port } = brokenGoTrue.address() as AddressInfo;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  try {
    const res = await request(app())
      .post("/auth/login")
      .set("Origin", origin)
      .send({ email: "lawyer@example.test", password: "correct horse battery" });
    await Sentry.flush(2000);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", request_id: "req-auth-outage" });
    const reported = events.filter((event) => event.logger !== "console");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.tags).toMatchObject({
      error_kind: "auth.supabase_unavailable",
      http_status: 500,
    });
    expect(events.filter((event) => event.logger === "console")).toHaveLength(0);
  } finally {
    process.env.SUPABASE_URL = ENV.SUPABASE_URL;
  }
});

describe("requireAuth with GoTrue unreachable", () => {
  function jwt(exp: number): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u1", exp, aud: "authenticated", role: "authenticated" })}.signature`;
  }
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: "u1", aud: "authenticated", email: "lawyer@example.test" };
  const session = { access_token: jwt(exp), refresh_token: "r1", expires_in: 3600, expires_at: exp, token_type: "bearer", user };
  const cookie = `mike-session=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

  it.each([
    ["a cookie session", (req: request.Test) => req.set("Cookie", cookie)],
    ["a bearer token", (req: request.Test) => req.set("Authorization", `Bearer ${jwt(exp)}`)],
  ])("answers %s 503 upstream_unavailable, not a 401 that signs the user out", async (_label, authenticate) => {
    const res = await authenticate(request(app()).get("/projects"));
    await Sentry.flush(2000);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: "upstream_unavailable",
      detail: "The server is temporarily unreachable. Please try again shortly.",
      request_id: "req-auth-outage",
    });
    // The session is kept: no cleared cookie on the way back.
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("Max-Age=0");
    const reported = events.filter((event) => event.logger !== "console");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.tags).toMatchObject({
      error_kind: "auth.supabase_unavailable",
      http_status: 503,
    });
    expect(events.filter((event) => event.logger === "console")).toHaveLength(0);
  });

  it("files one event per outage, not one per request, and reports the next outage after a quiet period", async () => {
    const warn = vi.mocked(console.warn);
    let clock = 1_000_000;
    resetUpstreamOutagesForTests(() => clock);
    const outageEvents = () =>
      events.filter(
        (event) =>
          event.logger !== "console" &&
          event.tags?.error_kind === "auth.supabase_unavailable",
      );
    const bearer = (req: request.Test) => req.set("Authorization", `Bearer ${jwt(exp)}`);

    for (let i = 0; i < 3; i++) {
      const res = await bearer(request(app()).get("/projects"));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("upstream_unavailable");
    }
    // A minute on: the quiet repeats are due their counted log line.
    clock += 60_000;
    const session = await bearer(request(app()).get("/auth/session"));
    expect(session.status).toBe(503);
    expect(session.body.code).toBe("upstream_unavailable");
    await Sentry.flush(2000);

    expect(outageEvents()).toHaveLength(1);
    expect(outageEvents()[0]!.tags).toMatchObject({
      operation: "auth.session",
      http_status: 503,
    });
    expect(outageEvents()[0]!.fingerprint?.[0]).toBe("upstream-unavailable");
    // The quiet repeats are counted in the log instead.
    expect(
      warn.mock.calls.some(([line]) => String(line).startsWith("[upstream-unavailable] still failing (gotrue:0)")),
    ).toBe(true);
    expect(events.filter((event) => event.logger === "console")).toHaveLength(0);

    // GoTrue comes back and a request authenticates.
    const { port } = healthySupabase.address() as AddressInfo;
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    try {
      const ok = await bearer(request(app()).get("/projects"));
      expect(ok.status).not.toBe(503);
    } finally {
      process.env.SUPABASE_URL = ENV.SUPABASE_URL;
    }

    // The next outage, more than the 15-minute window after the last report,
    // is news again (one returning sooner is the same outage flapping).
    clock += 15 * 60_000;
    const again = await bearer(request(app()).get("/projects"));
    expect(again.status).toBe(503);
    await Sentry.flush(2000);
    expect(outageEvents()).toHaveLength(2);
  });
});
