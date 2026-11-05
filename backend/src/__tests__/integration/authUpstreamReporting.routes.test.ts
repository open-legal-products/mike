// MIK-125: one GoTrue outage used to file three Sentry issues per auth route
// (authError's reportError, the response sanitizer's reportMessage, and the
// console bridge's copy of the sanitizer's console.error). This drives the
// real auth router behind the real sanitizer, with a real Supabase client
// pointed at a closed port and a real Sentry client whose transport records
// every event, so each of the three paths is counted where it is produced.
import express from "express";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetSentryForTests, scrubEvent } from "../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../lib/observability/sentryPrivacy";
import { protectInternalErrorResponses } from "../../middleware/internalErrorResponse";
import { authRouter } from "../../modules/auth/auth.routes";

const origin = "https://app.example.test";
const saved: Record<string, string | undefined> = {};
const ENV = {
  FRONTEND_URL: origin,
  // Port 9 (discard) is closed on CI runners and dev machines: auth-js gets
  // ECONNREFUSED and turns it into an AuthRetryableFetchError (status 0).
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
};

const events: Sentry.ErrorEvent[] = [];

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  events.length = 0;
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
