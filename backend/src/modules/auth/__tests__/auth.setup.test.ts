import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import {
  createFirstAccount,
  firstRunSetupEnabled,
  resetSignInOptionsCache,
  signInOptions,
} from "../auth.service";

type RpcAnswers = Record<string, { data: unknown; error: unknown }>;

function fakeDb(answers: RpcAnswers, createUser = vi.fn(async () => ({ error: null }))) {
  const rpc = vi.fn(async (name: string) => answers[name] ?? { data: null, error: null });
  return {
    db: { rpc, auth: { admin: { createUser } } } as unknown as Db,
    rpc,
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

describe("createFirstAccount", () => {
  const credentials = { email: "owner@example.com", password: "correct-horse-battery" };

  it("claims setup, then creates a confirmed account", async () => {
    const { db, rpc, createUser } = fakeDb({ claim_instance_setup: { data: true, error: null } });
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("claim_instance_setup");
    expect(createUser).toHaveBeenCalledWith({ ...credentials, email_confirm: true });
  });

  it("refuses without creating anything when the claim is taken", async () => {
    const { db, createUser } = fakeDb({ claim_instance_setup: { data: false, error: null } });
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({ ok: false, reason: "taken" });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("is unavailable unless the deployment enabled first-run setup", async () => {
    delete process.env.MIKE_FIRST_RUN_SETUP;
    const { db, rpc } = fakeDb({ claim_instance_setup: { data: true, error: null } });
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gives the claim back when the account cannot be created", async () => {
    const authFailure = { status: 422, code: "weak_password" };
    const createUser = vi.fn(async () => ({ error: authFailure }));
    const { db, rpc } = fakeDb({ claim_instance_setup: { data: true, error: null } }, createUser);
    await expect(createFirstAccount(db, credentials)).resolves.toEqual({
      ok: false,
      reason: "auth_error",
      error: authFailure,
    });
    expect(rpc).toHaveBeenCalledWith("release_instance_setup");
  });

  it("gives the claim back when Auth cannot be reached", async () => {
    const createUser = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { db, rpc } = fakeDb({ claim_instance_setup: { data: true, error: null } }, createUser);
    await expect(createFirstAccount(db, credentials)).rejects.toThrow("fetch failed");
    expect(rpc).toHaveBeenCalledWith("release_instance_setup");
  });
});

describe("signInOptions", () => {
  it("reports Google from Supabase Auth's settings and setup from the database", async () => {
    const { db } = fakeDb({ instance_setup_available: { data: true, error: null } });
    const fetchImpl = settingsFetch({ external: { google: false, email: true } });
    await expect(signInOptions(db, fetchImpl)).resolves.toEqual({
      google: false,
      sso: false,
      setupRequired: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://project.supabase.test/auth/v1/settings",
      expect.objectContaining({ headers: { apikey: "publishable" } }),
    );
  });

  it("reports SSO from the backend's own configuration", async () => {
    process.env.SSO_ENABLED = "true";
    const { db } = fakeDb({ instance_setup_available: { data: false, error: null } });
    await expect(
      signInOptions(db, settingsFetch({ external: { google: true } })),
    ).resolves.toEqual({ google: true, sso: true, setupRequired: false });
  });

  it("keeps Google visible when Auth's settings cannot be read", async () => {
    const { db } = fakeDb({ instance_setup_available: { data: false, error: null } });
    await expect(signInOptions(db, settingsFetch({}, false))).resolves.toMatchObject({ google: true });
  });

  it("never offers setup unless the deployment enabled it", async () => {
    delete process.env.MIKE_FIRST_RUN_SETUP;
    const { db, rpc } = fakeDb({ instance_setup_available: { data: true, error: null } });
    await expect(
      signInOptions(db, settingsFetch({ external: { google: true } })),
    ).resolves.toMatchObject({ setupRequired: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});
