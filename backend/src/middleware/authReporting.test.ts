// What Sentry sees when the auth middleware itself fails: one event per
// failure, named by its kind, with the route that refused the request —
// never a bare "Server auth is not configured" message event, and never the
// dependency's message in the response body.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/appError";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn((..._args: unknown[]) => "event-1"),
  createServerSupabase: vi.fn(),
  createRequestSupabase: vi.fn(),
  assurance: vi.fn(),
}));
vi.mock("../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError: mocks.reportError,
}));
vi.mock("../lib/log", () => ({ devLog: vi.fn(), isDev: false }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => mocks.createServerSupabase(),
}));
vi.mock("../lib/authSession", () => ({
  createRequestSupabase: () => mocks.createRequestSupabase(),
}));
import { requireAuth, requireMfaIfEnrolled } from "./auth";

const ROUTE = "/user/profile";

function adminClient() {
  return {
    auth: {
      mfa: { getAuthenticatorAssuranceLevel: mocks.assurance },
      getUser: vi.fn(),
    },
    from: vi.fn(),
  };
}

function appWith(middleware: typeof requireAuth) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = "req-1";
    res.locals.token = "session-token";
    res.locals.userId = "u1";
    next();
  });
  app.get(ROUTE, middleware, (_req, res) => res.json({ ok: true }));
  return app;
}

function reportedFailure(): AppError {
  expect(mocks.reportError).toHaveBeenCalledOnce();
  const [failure] = mocks.reportError.mock.calls[0] as unknown as [unknown];
  expect(failure).toBeInstanceOf(AppError);
  return failure as AppError;
}

describe("auth middleware failure reporting", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createServerSupabase.mockReturnValue(adminClient());
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reports a cookie session that could not be initialised once, by kind, with the route", async () => {
    const cause = new Error("SUPABASE_URL is not set: https://internal.example");
    mocks.createRequestSupabase.mockImplementation(() => {
      throw cause;
    });

    const res = await request(appWith(requireAuth)).get(ROUTE);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
      request_id: "req-1",
    });
    expect(res.text).not.toContain("SUPABASE_URL");
    const failure = reportedFailure();
    expect(failure.kind).toBe("auth.session_lookup_failed");
    expect(failure.cause).toBe(cause);
    expect(mocks.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { component: "http", http_status: 500, http_route: ROUTE },
    });
    // The log line carries the same object the report did, so the console
    // bridge files nothing twice.
    expect(console.error).toHaveBeenCalledWith(
      "[http/internal-error]",
      expect.objectContaining({ error: failure }),
    );
  });

  it("reports a missing admin client as auth.supabase_unavailable instead of a bare 500", async () => {
    const cause = new Error("missing SUPABASE_SECRET_KEY");
    mocks.createServerSupabase.mockImplementation(() => {
      throw cause;
    });

    const res = await request(appWith(requireAuth)).get(ROUTE);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    const failure = reportedFailure();
    expect(failure.kind).toBe("auth.supabase_unavailable");
    expect(failure.cause).toBe(cause);
  });

  it("keeps the 401 when the assurance lookup fails and reports the outage as a warning", async () => {
    const gotrueError = { message: "gotrue unavailable", status: 502 };
    mocks.assurance.mockResolvedValue({ data: null, error: gotrueError });

    const res = await request(appWith(requireMfaIfEnrolled)).get(ROUTE);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    const failure = reportedFailure();
    expect(failure.kind).toBe("auth.mfa_assurance_failed");
    expect(failure.cause).toBe(gotrueError);
    expect(mocks.reportError.mock.calls[0]?.[1]).toMatchObject({
      level: "warning",
      tags: { component: "http", http_method: "GET", http_route: ROUTE },
    });
    expect(console.error).toHaveBeenCalledWith(
      "[auth/mfa] assurance lookup failed",
      failure,
    );
  });
});
