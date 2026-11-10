// A deployment that has not run the login-MFA migration has no
// user_profiles.mfa_on_login column. The preference lookup then fails with
// 42703 and enforcement cannot apply, so the request proceeds as before — but
// the degraded state is reported once per process instead of being silent,
// through the same schema-out-of-date gate as every other missing migration.
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/appError";
import { resetSchemaOutOfDateReportsForTests } from "../lib/schemaOutOfDate";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn((..._args: unknown[]) => "event-1"),
  mfaLookup: vi.fn(),
}));
vi.mock("../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError: mocks.reportError,
}));
vi.mock("../lib/log", () => ({ devLog: vi.fn(), isDev: false }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => adminClient(),
}));

import { requireAuth } from "./auth";

const USER = { id: "u1", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const COLUMN_MISSING = {
  code: "42703",
  message: 'column user_profiles.mfa_on_login does not exist',
};

/** The admin client as the middleware sees it: one `user_profiles` read per concern. */
function adminClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: USER }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: vi.fn() },
    },
    from: (table: string) => {
      expect(table).toBe("user_profiles");
      return {
        select: (columns: string) => ({
          eq: () => ({
            maybeSingle: async () => {
              if (columns === "account_deletion_requested_at") return { data: null, error: null };
              if (columns === "email") return { data: { email: USER.email }, error: null };
              if (columns === "mfa_on_login") return mocks.mfaLookup();
              throw new Error(`unexpected select ${columns}`);
            },
          }),
        }),
      };
    },
  };
}

function app() {
  const server = express();
  server.use((_req, res, next) => {
    res.locals.requestId = "req-1";
    next();
  });
  // The real app rate-limits every auth-guarded route (app.ts); CodeQL's
  // js/missing-rate-limiting query expects the same in front of this one.
  const limiter = rateLimit({ windowMs: 60_000, limit: 100 });
  server.get("/projects", limiter, requireAuth, (_req, res) => res.json({ ok: true }));
  return server;
}

const get = () => request(app()).get("/projects").set("Authorization", "Bearer session-token");

describe("login MFA preference column missing (pre-migration database)", () => {
  beforeEach(() => {
    resetSchemaOutOfDateReportsForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("lets the request through and reports the degraded state once, through the schema-out-of-date gate", async () => {
    mocks.mfaLookup.mockResolvedValue({ data: null, error: COLUMN_MISSING });

    const first = await get();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [failure, options] = mocks.reportError.mock.calls[0] as unknown as [AppError, unknown];
    expect(failure).toBeInstanceOf(AppError);
    // One kind and one level for every missing migration, so the org
    // alert rule fires on it like on any other.
    expect(failure.kind).toBe("schema_out_of_date");
    expect(failure.cause).toBe(COLUMN_MISSING);
    // The operation keeps the event's meaning (login MFA not enforced) in
    // its Sentry title and tags; it is still the single schema_out_of_date
    // event of the gate.
    expect(options).toMatchObject({
      level: "error",
      tags: { component: "http", operation: "auth.login_mfa" },
    });
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain(
      "login MFA enforcement is not active",
    );

    const second = await get();
    expect(second.status).toBe(200);
    expect(mocks.reportError).toHaveBeenCalledOnce();

    // The once-state is the gate's, not a second flag of its own: forget
    // the gate and the same failure is news again. A private once-flag
    // would stay quiet here, and could report the column a second time
    // beside the gate.
    resetSchemaOutOfDateReportsForTests();
    await get();
    expect(mocks.reportError).toHaveBeenCalledTimes(2);
  });

  it("still answers 500 for any other preference lookup failure", async () => {
    mocks.mfaLookup.mockResolvedValue({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
  });

  it("enforces nothing extra when the column exists and the preference is off", async () => {
    mocks.mfaLookup.mockResolvedValue({ data: { mfa_on_login: false }, error: null });
    const res = await get();
    expect(res.status).toBe(200);
    // The once-per-process report from the first test must not repeat here.
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
