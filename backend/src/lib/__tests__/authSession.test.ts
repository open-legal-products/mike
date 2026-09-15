import { beforeEach, describe, expect, it, vi } from "vitest";

// The stub's parameters are declared rather than left off: with `vi.fn(() =>
// …)` the recorded call tuple is empty, so the `mock.calls[0][2]` lookups
// below would type-check against nothing at all.
const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(
    (_url: string, _key: string, _options: Record<string, unknown>) => ({
      auth: {},
    }),
  ),
}));

vi.mock("@supabase/ssr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/ssr")>()),
  createServerClient,
}));

import {
  authCookieName,
  authCookiesAreSecure,
  clearRequestAuthCookies,
  createRequestSupabase,
  publicAuthUser,
} from "../authSession";

describe("backend-managed auth cookies", () => {
  beforeEach(() => {
    createServerClient.mockClear();
    process.env.SUPABASE_URL = "https://auth.example.test";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-key";
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.WORD_ADDIN_URL;
    process.env.NODE_ENV = "development";
  });

  it("uses a Secure __Host cookie in production", () => {
    const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(authCookiesAreSecure(env)).toBe(true);
    expect(authCookieName(env)).toBe("__Host-mike-session");
  });

  it("uses an unprefixed cookie for local development", () => {
    const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(authCookiesAreSecure(env)).toBe(false);
    expect(authCookieName(env)).toBe("mike-session");
  });

  it("forces HttpOnly, SameSite=Lax, Secure, and Path=/ on every session write", () => {
    process.env.NODE_ENV = "production";
    const append = vi.fn();
    const setHeader = vi.fn();
    const req = {
      headers: { cookie: "" },
      get: vi.fn().mockReturnValue(undefined),
    } as never;
    const res = { append, setHeader } as never;

    createRequestSupabase(req, res);

    expect(createServerClient).toHaveBeenCalledWith(
      "https://auth.example.test",
      "publishable-test-key",
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          name: "__Host-mike-session",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        }),
      }),
    );

    const options = createServerClient.mock.calls[0]![2] as unknown as {
      cookies: {
        setAll(
          cookies: Array<{
            name: string;
            value: string;
            options: Record<string, unknown>;
          }>,
          headers: Record<string, string>,
        ): void;
      };
    };
    options.cookies.setAll(
      [
        {
          name: "__Host-mike-session",
          value: "opaque-session",
          options: { maxAge: 3600, httpOnly: false, sameSite: "none" },
        },
      ],
      { "x-supabase-api-version": "2024-01-01" },
    );

    const cookie = append.mock.calls[0][1] as string;
    expect(cookie).toContain("__Host-mike-session=opaque-session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(setHeader).toHaveBeenCalledWith(
      "x-supabase-api-version",
      "2024-01-01",
    );
  });

  it("uses partitioned SameSite=None cookies for the Word task pane", () => {
    process.env.NODE_ENV = "production";
    process.env.WORD_ADDIN_URL = "https://word.example.test";
    const append = vi.fn();
    const req = {
      headers: { cookie: "" },
      get: vi.fn().mockReturnValue("https://word.example.test"),
    } as never;
    const res = { append, setHeader: vi.fn() } as never;

    createRequestSupabase(req, res);
    const options = createServerClient.mock.calls[0]![2] as unknown as {
      cookies: {
        setAll(
          cookies: Array<{
            name: string;
            value: string;
            options: Record<string, unknown>;
          }>,
          headers: Record<string, string>,
        ): void;
      };
    };
    options.cookies.setAll(
      [{ name: "__Host-mike-session", value: "opaque", options: {} }],
      {},
    );

    const cookie = append.mock.calls[0][1] as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
  });

  it("expires every chunk belonging to the request session", () => {
    const append = vi.fn();
    const setHeader = vi.fn();
    const req = {
      headers: {
        cookie:
          "mike-session.0=first; unrelated=keep; mike-session.1=second; mike-session-code-verifier=pkce",
      },
      get: vi.fn().mockReturnValue(undefined),
    } as never;
    const res = { append, setHeader } as never;

    clearRequestAuthCookies(req, res);

    expect(append).toHaveBeenCalledTimes(3);
    expect(append.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("mike-session.0="),
      expect.stringContaining("mike-session.1="),
      expect.stringContaining("mike-session-code-verifier="),
    ]);
    for (const [, cookie] of append.mock.calls) {
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("returns only the user fields clients need", () => {
    expect(
      publicAuthUser({
        id: "user-1",
        email: "lawyer@example.com",
        new_email: "new@example.com",
        app_metadata: { provider: "google", secret: "hidden" },
        user_metadata: { private: "hidden" },
      } as never),
    ).toEqual({
      id: "user-1",
      email: "lawyer@example.com",
      pendingEmail: "new@example.com",
      createdWithGoogle: true,
    });
  });
});
