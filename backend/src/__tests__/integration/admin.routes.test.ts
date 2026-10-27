import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Response } from "express";

const mocks = vi.hoisted(() => ({
  auth: true,
  email: "will@example.com" as string | undefined,
  mfa: true,
  defaults: [] as Record<string, unknown>[],
  overrides: [] as Record<string, unknown>[],
  profiles: [] as Record<string, unknown>[],
  audit: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_r: unknown, res: Response, next: () => void) => {
    if (!mocks.auth) return void res.status(401).end();
    res.locals.userId = "admin-user";
    res.locals.userEmail = mocks.email;
    next();
  },
  requireMfaIfEnrolled: (_r: unknown, res: Response, next: () => void) => {
    if (!mocks.mfa)
      return void res.status(403).json({ code: "mfa_verification_required" });
    next();
  },
}));
vi.mock("../../lib/audit", () => ({ recordAudit: mocks.audit }));

/** select/eq/in/maybeSingle, upsert and delete over three in-memory tables. */
function fakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    feature_flag_defaults: mocks.defaults,
    user_feature_flags: mocks.overrides,
    user_profiles: mocks.profiles,
  };
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      let operation = "select";
      let single = false;
      let patch: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq(k: string, v: unknown) {
          filters.push((r) => r[k] === v);
          return query;
        },
        in(k: string, v: unknown[]) {
          filters.push((r) => v.includes(r[k]));
          return query;
        },
        limit: () => query,
        maybeSingle() {
          single = true;
          return query;
        },
        upsert(v: Record<string, unknown>) {
          operation = "upsert";
          patch = v;
          return query;
        },
        delete() {
          operation = "delete";
          return query;
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          const found = rows.filter((r) => filters.every((f) => f(r)));
          if (operation === "upsert") {
            const same = (r: Record<string, unknown>) =>
              r.flag === patch.flag && (r.user_id ?? null) === (patch.user_id ?? null);
            const existing = rows.find(same);
            if (existing) Object.assign(existing, patch);
            else rows.push({ ...patch });
          }
          if (operation === "delete") found.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return Promise.resolve({
            data: single ? (found[0] ?? null) : found,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => fakeDb() }));

import { app } from "../../app";

const USER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = true;
  mocks.mfa = true;
  mocks.email = "will@example.com";
  mocks.defaults.length = 0;
  mocks.overrides.length = 0;
  mocks.profiles.length = 0;
  mocks.profiles.push({ user_id: USER, email: "pat@example.com", display_name: "Pat" });
  vi.stubEnv("MIKE_ADMIN_EMAILS", "will@example.com");
  vi.stubEnv("GOOGLE_WORKSPACE_DISABLED_PROVIDERS", "gmail");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("admin routes", () => {
  it("refuses everyone the server does not list, before any handler runs", async () => {
    mocks.email = "pat@example.com";
    for (const call of [
      request(app).get("/admin/feature-flags"),
      request(app).put("/admin/feature-flags/gmail-read").send({ enabled: true }),
      request(app).get("/admin/users/feature-flags?email=pat@example.com"),
      request(app).put(`/admin/users/${USER}/feature-flags/gmail-read`).send({ enabled: true }),
    ]) {
      const response = await call;
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "instance_admin_required" });
    }
    expect(mocks.defaults).toEqual([]);
    expect(mocks.overrides).toEqual([]);
    // An unconfirmed address is "" and matches nothing.
    mocks.email = "";
    expect((await request(app).get("/admin/feature-flags")).status).toBe(403);
    mocks.auth = false;
    expect((await request(app).get("/admin/feature-flags")).status).toBe(401);
  });

  it("lists every flag with its code default and sets a deployment default", async () => {
    const listed = await request(app).get("/admin/feature-flags");
    expect(listed.status).toBe(200);
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(listed.body.flags.map((f: { key: string }) => f.key)).toEqual([
      "google-drive",
      "gmail-read",
      "gmail-write",
      "google-calendar-read",
      "google-calendar-write",
    ]);
    expect(listed.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toMatchObject({
      label: "Gmail: read",
      group: "Google",
      codeDefault: false,
      deploymentDefault: null,
      effectiveDefault: false,
    });

    const set = await request(app).put("/admin/feature-flags/gmail-read").send({ enabled: true });
    expect(set.status).toBe(200);
    expect(set.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toMatchObject({
      codeDefault: false,
      deploymentDefault: true,
      effectiveDefault: true,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "admin-user",
        action: "feature_flag.default_updated",
        detail: { flag: "gmail-read", enabled: true },
      }),
    );

    const cleared = await request(app).put("/admin/feature-flags/gmail-read").send({ enabled: null });
    expect(cleared.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toMatchObject({
      deploymentDefault: null,
      effectiveDefault: false,
    });
  });

  it("rejects unknown flags and non-boolean values, and steps up to MFA for changes", async () => {
    expect((await request(app).put("/admin/feature-flags/not-a-flag").send({ enabled: true })).status).toBe(404);
    expect((await request(app).put("/admin/feature-flags/gmail-read").send({ enabled: "yes" })).status).toBe(400);
    expect((await request(app).put("/admin/feature-flags/gmail-read").send({})).status).toBe(400);
    mocks.mfa = false;
    expect((await request(app).put("/admin/feature-flags/gmail-read").send({ enabled: true })).status).toBe(403);
    expect((await request(app).get("/admin/feature-flags")).status).toBe(200);
    expect(mocks.defaults).toEqual([]);
  });

  it("finds a user by email and sets, then clears, an override", async () => {
    expect((await request(app).get("/admin/users/feature-flags")).status).toBe(400);
    const missing = await request(app).get("/admin/users/feature-flags?email=nobody@example.com");
    expect(missing.status).toBe(404);

    const found = await request(app).get("/admin/users/feature-flags?email=Pat@Example.com");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ userId: USER, email: "pat@example.com", displayName: "Pat" });
    expect(found.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toEqual({
      key: "gmail-read",
      override: null,
      enabled: false,
    });

    const set = await request(app).put(`/admin/users/${USER}/feature-flags/gmail-read`).send({ enabled: true });
    expect(set.status).toBe(200);
    expect(set.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toEqual({
      key: "gmail-read",
      override: true,
      enabled: true,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feature_flag.user_updated",
        detail: { flag: "gmail-read", enabled: true, subjectUserId: USER },
      }),
    );

    const cleared = await request(app).put(`/admin/users/${USER}/feature-flags/gmail-read`).send({ enabled: null });
    expect(cleared.body.flags.find((f: { key: string }) => f.key === "gmail-read")).toEqual({
      key: "gmail-read",
      override: null,
      enabled: false,
    });
    expect(mocks.overrides).toEqual([]);

    expect((await request(app).put("/admin/users/not-a-uuid/feature-flags/gmail-read").send({ enabled: true })).status).toBe(400);
    const unknownUser = "33333333-3333-4333-8333-333333333333";
    expect((await request(app).put(`/admin/users/${unknownUser}/feature-flags/gmail-read`).send({ enabled: true })).status).toBe(404);
  });
});
