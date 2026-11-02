import type { Request, Response } from "express";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ profile: vi.fn(), sync: vi.fn() }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: mocks.sync }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u", email: "u@example.test" } } }) },
    from: () => { const q = { select: () => q, eq: () => q, maybeSingle: mocks.profile }; return q; },
}) }));
import { requireAuth } from "./auth";
beforeEach(() => vi.clearAllMocks());
it.each([
    [{ data: { account_deletion_requested_at: "2026-10-13" }, error: null }, 401],
    [{ data: null, error: { message: "database unavailable" } }, 500],
])("blocks pending deletion and fails closed when its status cannot be checked", async (result, status) => {
    mocks.profile.mockResolvedValue(result);
    const req = { headers: { authorization: "Bearer valid-token" }, method: "GET", originalUrl: "/projects" } as Request;
    const res = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireAuth(req as never, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(status); expect(next).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled(); expect(res.locals).toEqual({});
});
