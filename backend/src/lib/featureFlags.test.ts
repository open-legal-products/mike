import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "./supabase";
import {
  FEATURE_FLAG_KEYS,
  isFeatureFlagKey,
  loadFeatureFlagDefaults,
  resolveFeatureFlags,
  setFeatureFlagDefault,
  setUserFeatureFlag,
} from "./featureFlags";

type Row = Record<string, unknown>;

/** Just enough of supabase-js for the flag tables: select/eq, upsert, delete/eq. */
function flagDb(seed: { defaults?: Row[]; overrides?: Row[]; failWith?: unknown } = {}) {
  const tables: Record<string, Row[]> = {
    feature_flag_defaults: seed.defaults ?? [],
    user_feature_flags: seed.overrides ?? [],
  };
  const keyOf = (table: string, row: Row) =>
    table === "feature_flag_defaults" ? `${row.flag}` : `${row.user_id}:${row.flag}`;
  const db = {
    from(table: string) {
      const rows = tables[table];
      const filters: ((r: Row) => boolean)[] = [];
      let operation = "select";
      let patch: Row = {};
      const query = {
        select: () => query,
        eq(k: string, v: unknown) {
          filters.push((r) => r[k] === v);
          return query;
        },
        upsert(v: Row) {
          operation = "upsert";
          patch = v;
          return query;
        },
        delete() {
          operation = "delete";
          return query;
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          if (seed.failWith)
            return Promise.resolve({ data: null, error: seed.failWith }).then(resolve, reject);
          const found = rows.filter((r) => filters.every((f) => f(r)));
          if (operation === "upsert") {
            const existing = rows.find((r) => keyOf(table, r) === keyOf(table, patch));
            if (existing) Object.assign(existing, patch);
            else rows.push({ ...patch });
          }
          if (operation === "delete") found.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return Promise.resolve({ data: found, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { tables, db: db as unknown as Db };
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_WORKSPACE_DISABLED_PROVIDERS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("feature flags", () => {
  it("knows exactly the registered keys", () => {
    expect(FEATURE_FLAG_KEYS).toEqual([
      "google-drive",
      "gmail-read",
      "gmail-write",
      "google-calendar-read",
      "google-calendar-write",
    ]);
    expect(isFeatureFlagKey("gmail-read")).toBe(true);
    expect(isFeatureFlagKey("toString")).toBe(false);
    expect(isFeatureFlagKey("__proto__")).toBe(false);
    expect(isFeatureFlagKey(42)).toBe(false);
  });

  it("resolves override, then deployment default, then code default", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DISABLED_PROVIDERS", "gmail");
    const { db } = flagDb({
      defaults: [{ flag: "google-calendar-read", enabled: false }],
      overrides: [
        { user_id: "u1", flag: "gmail-read", enabled: true },
        { user_id: "u2", flag: "google-calendar-read", enabled: true },
      ],
    });
    const u1 = await resolveFeatureFlags(db, "u1");
    // The env switch is the code default: gmail off, and nothing above it for gmail-write.
    expect(u1["gmail-write"]).toEqual({
      codeDefault: false,
      deploymentDefault: null,
      override: null,
      enabled: false,
    });
    // An override wins over the code default.
    expect(u1["gmail-read"]).toMatchObject({ codeDefault: false, override: true, enabled: true });
    // A deployment default wins over the code default...
    expect(u1["google-calendar-read"]).toMatchObject({
      codeDefault: true,
      deploymentDefault: false,
      override: null,
      enabled: false,
    });
    // ...and an override wins over the deployment default.
    expect((await resolveFeatureFlags(db, "u2"))["google-calendar-read"]).toMatchObject({
      deploymentDefault: false,
      override: true,
      enabled: true,
    });
    expect(u1["google-drive"].enabled).toBe(true);
  });

  it("ignores rows for flags the code no longer knows", async () => {
    const { db } = flagDb({
      defaults: [{ flag: "retired-flag", enabled: true }],
      overrides: [{ user_id: "u1", flag: "retired-flag", enabled: true }],
    });
    expect(Object.keys(await loadFeatureFlagDefaults(db))).toEqual([]);
    expect(Object.keys(await resolveFeatureFlags(db, "u1"))).toEqual(FEATURE_FLAG_KEYS);
  });

  it("keeps every code default when the tables do not exist yet", async () => {
    const { db } = flagDb({ failWith: { code: "42P01", message: "relation does not exist" } });
    const flags = await resolveFeatureFlags(db, "u1");
    expect(FEATURE_FLAG_KEYS.every((k) => flags[k].enabled && flags[k].override === null)).toBe(true);
  });

  it("surfaces any other database error", async () => {
    const { db } = flagDb({ failWith: { code: "08006", message: "connection failure" } });
    await expect(resolveFeatureFlags(db, "u1")).rejects.toMatchObject({ code: "08006" });
  });

  it("sets and clears a deployment default and a user override", async () => {
    const { db, tables } = flagDb();
    await setFeatureFlagDefault(db, "gmail-read", false, "admin");
    await setFeatureFlagDefault(db, "gmail-read", true, "admin");
    expect(tables.feature_flag_defaults).toEqual([
      expect.objectContaining({ flag: "gmail-read", enabled: true, updated_by: "admin" }),
    ]);
    await setUserFeatureFlag(db, "u1", "gmail-read", false, "admin");
    expect((await resolveFeatureFlags(db, "u1"))["gmail-read"]).toMatchObject({
      deploymentDefault: true,
      override: false,
      enabled: false,
    });
    await setUserFeatureFlag(db, "u1", "gmail-read", null, "admin");
    await setFeatureFlagDefault(db, "gmail-read", null, "admin");
    expect(tables.feature_flag_defaults).toEqual([]);
    expect(tables.user_feature_flags).toEqual([]);
    expect((await resolveFeatureFlags(db, "u1"))["gmail-read"].enabled).toBe(true);
  });
});
