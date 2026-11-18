import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import {
  createFirstAccount,
  emailSignupOpen,
  firstRunSetupEnabled,
  resetSignInOptionsCache,
  signInOptions,
} from "../auth.service";

type ListUsersAnswer = { data: { users: unknown[] }; error: unknown };

/** A service-role client whose GoTrue admin API answers as given. */
function fakeDb(
  { accounts = 0, listError = null }: { accounts?: number; listError?: unknown } = {},
  createUser: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ({ error: null })),
) {
  const listUsers = vi.fn(
    async (): Promise<ListUsersAnswer> => ({
      data: { users: Array.from({ length: Math.min(accounts, 1) }, (_, i) => ({ id: `u${i}` })) },
      error: listError,
    }),
  );
  return {
    db: { auth: { admin: { listUsers, createUser } } } as unknown as Db,
    listUsers,
    createUser,
  };
}

const settingsFetch = (body: unknown, ok = true) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

beforeEach(() => {
  process.env.MIKE_FIRST_RUN_SETUP = "true";
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
  delete process.env.SSO_ENABLED;
  resetSignInOptionsCache();
});

afterEach(() => {
  delete process.env.MIKE_FIRST_RUN_SETUP;
});

describe("firstRunSetupEnabled", () => {
  it("is on only when the deployment asks for it", () => {
    expect(firstRunSetupEnabled({ MIKE_FIRST_RUN_SETUP: "true" })).toBe(true);
    expect(firstRunSetupEnabled({ MIKE_FIRST_RUN_SETUP: "TRUE " })).toBe(true);
    expect(firstRunSetupEnabled({})).toBe(false);
    expect(firstRunSetupEnabled({ MIKE_FIRST_RUN_SETUP: "1" })).toBe(false);
  });
});

describe("emailSignupOpen", () => {
  it("leaves sign-up open on installs without first-run setup", () => {
    expect(emailSignupOpen({})).toBe(true);
  });

  it("keeps sign-up closed on a first-run deployment until email is configured", () => {
    expect(emailSignupOpen({ MIKE_FIRST_RUN_SETUP: "true" })).toBe(false);
    expect(
      emailSignupOpen({ MIKE_FIRST_RUN_SETUP: "true", MIKE_SIGNUP_EMAIL_CONFIGURED: "true" }),
    ).toBe(true);
  });
});

describe("createFirstAccount", () => {
  const credentials = { email: "owner@example.com", password: "correct-horse-battery" };

  it("creates a confirmed account while the instance has none", async () => {
    const { db, listUsers, createUser } = fakeDb();
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({ ok: true });
    expect(listUsers).toHaveBeenCalledWith({ page: 1, perPage: 1 });
    expect(createUser).toHaveBeenCalledWith({ ...credentials, email_confirm: true });
  });

  it("refuses without creating anything once an account exists", async () => {
    const { db, createUser } = fakeDb({ accounts: 1 });
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({ ok: false, reason: "taken" });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("is unavailable unless the deployment enabled first-run setup", async () => {
    delete process.env.MIKE_FIRST_RUN_SETUP;
    const { db, listUsers, createUser } = fakeDb();
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(listUsers).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("passes Auth's own refusal back to the route", async () => {
    const authFailure = { status: 422, code: "weak_password" };
    const { db } = fakeDb({}, vi.fn(async () => ({ error: authFailure })));
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({
      ok: false,
      reason: "auth_error",
      error: authFailure,
    });
  });

  it("does not create an account when it cannot tell whether one exists", async () => {
    const listFailure = new Error("Auth admin unavailable");
    const { db, createUser } = fakeDb({ listError: listFailure });
    await expect(createFirstAccount(db, credentials)).rejects.toBe(listFailure);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("lets a failure to reach Auth surface", async () => {
    const createUser = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { db } = fakeDb({}, createUser);
    await expect(createFirstAccount(db, credentials)).rejects.toThrow("fetch failed");
  });
});

describe("signInOptions", () => {
  it("reports Google from Supabase Auth's settings and setup from its user list", async () => {
    const { db } = fakeDb();
    const fetchImpl = settingsFetch({ external: { google: false, email: true } });
    await expect(signInOptions(db, fetchImpl)).resolves.toEqual({
      google: false,
      sso: false,
      setupRequired: true,
      signup: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://project.supabase.test/auth/v1/settings",
      expect.objectContaining({ headers: { apikey: "publishable" } }),
    );
  });

  it("stops offering setup once an account exists", async () => {
    const { db } = fakeDb({ accounts: 3 });
    await expect(
      signInOptions(db, settingsFetch({ external: { google: true } })),
    ).resolves.toMatchObject({ setupRequired: false });
  });

  it("reports SSO from the backend's own configuration", async () => {
    process.env.SSO_ENABLED = "true";
    const { db } = fakeDb({ accounts: 1 });
    await expect(
      signInOptions(db, settingsFetch({ external: { google: true } })),
    ).resolves.toEqual({ google: true, sso: true, setupRequired: false, signup: false });
  });

  it("keeps Google visible when Auth's settings cannot be read", async () => {
    const { db } = fakeDb({ accounts: 1 });
    await expect(signInOptions(db, settingsFetch({}, false))).resolves.toMatchObject({ google: true });
  });

  it("never offers setup unless the deployment enabled it", async () => {
    delete process.env.MIKE_FIRST_RUN_SETUP;
    const { db, listUsers } = fakeDb();
    await expect(
      signInOptions(db, settingsFetch({ external: { google: true } })),
    ).resolves.toMatchObject({ setupRequired: false });
    expect(listUsers).not.toHaveBeenCalled();
  });
});
