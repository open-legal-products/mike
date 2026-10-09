import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `res.locals.userEmail` is what every direct grant and organization
// invitation is matched against, so an address the account never confirmed
// must not reach it.
const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: async () => null }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: { getUser: mocks.getUser },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    },
  }),
}));
import { requireAuth } from "./auth";

// The middleware is driven directly rather than mounted on an app: the
// behaviour under test is what it writes to res.locals.
async function authenticatedEmail(): Promise<unknown> {
  const req = {
    headers: { authorization: "Bearer token" },
    method: "GET",
    originalUrl: "/probe",
    get: () => undefined,
  } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn() as unknown as NextFunction;
  await requireAuth(req as never, res as unknown as Response, next);
  expect(res.status).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  return res.locals.userEmail;
}

describe("requireAuth email trust", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes a confirmed email, normalized", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u1",
          email: "Person@Example.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        },
      },
      error: null,
    });
    expect(await authenticatedEmail()).toBe("person@example.com");
  });

  it("withholds an unconfirmed email so it matches no grant or invitation", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: { id: "u1", email: "victim@example.com", email_confirmed_at: null },
      },
      error: null,
    });
    expect(await authenticatedEmail()).toBe("");
  });
});
