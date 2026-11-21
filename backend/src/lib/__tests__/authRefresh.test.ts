import { describe, expect, it, vi } from "vitest";
import { refreshKey, singleFlightRefreshFetch } from "../authRefresh";

const TOKEN_URL = "http://gotrue.test/auth/v1/token?grant_type=refresh_token";
const refresh = (token: string): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ refresh_token: token }),
});

describe("refreshKey", () => {
  it("keys a refresh call by GoTrue URL and body, without the token in the clear", () => {
    const key = refreshKey(TOKEN_URL, refresh("secret-refresh-token"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("secret-refresh-token");
    expect(refreshKey(new URL(TOKEN_URL), refresh("secret-refresh-token"))).toBe(key);
    expect(refreshKey(new Request(TOKEN_URL, { method: "POST" }), refresh("secret-refresh-token"))).toBe(key);
    expect(refreshKey(TOKEN_URL, refresh("another-token"))).not.toBe(key);
    expect(refreshKey("http://other-gotrue.test/auth/v1/token?grant_type=refresh_token", refresh("secret-refresh-token"))).not.toBe(key);
  });

  it("matches a GoTrue behind a path prefix", () => {
    expect(refreshKey("http://kong.test/prefix/auth/v1/token?grant_type=refresh_token", refresh("t"))).not.toBeNull();
  });

  it.each([
    ["a GET", TOKEN_URL, { method: "GET" }],
    ["a POST without a string body", TOKEN_URL, { method: "POST", body: new URLSearchParams({ refresh_token: "t" }) }],
    ["a password grant", "http://gotrue.test/auth/v1/token?grant_type=password", refresh("t")],
    ["another GoTrue endpoint", "http://gotrue.test/auth/v1/user?grant_type=refresh_token", refresh("t")],
    ["an unparsable URL", "not a url", refresh("t")],
    ["no init at all", TOKEN_URL, undefined],
  ])("is null for %s", (_label, input, init) => {
    expect(refreshKey(input, init as RequestInit | undefined)).toBeNull();
  });
});

describe("singleFlightRefreshFetch", () => {
  function gotrue() {
    const pending: Array<(response: Response) => void> = [];
    const base = vi.fn(
      () => new Promise<Response>((resolve) => { pending.push(resolve); }),
    );
    return {
      base: base as unknown as typeof fetch,
      calls: () => base.mock.calls.length,
      answer: (response: Response) => pending.shift()!(response),
    };
  }

  it("sends one refresh for concurrent callers and gives each its own copy", async () => {
    const goTrue = gotrue();
    const wrapped = singleFlightRefreshFetch(goTrue.base);

    const callers = [wrapped(TOKEN_URL, refresh("t1")), wrapped(TOKEN_URL, refresh("t1")), wrapped(TOKEN_URL, refresh("t1"))];
    await Promise.resolve();
    expect(goTrue.calls()).toBe(1);
    goTrue.answer(new Response('{"access_token":"new"}', {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "999" },
    }));

    const responses = await Promise.all(callers);
    for (const response of responses) {
      expect(response.status).toBe(200);
      // Each caller can read its own body.
      await expect(response.json()).resolves.toEqual({ access_token: "new" });
      // The body is already decoded, so the wire framing headers are dropped.
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-type")).toBe("application/json");
    }
  });

  it("does not reuse a successful refresh once it has settled", async () => {
    const goTrue = gotrue();
    const wrapped = singleFlightRefreshFetch(goTrue.base);

    const first = wrapped(TOKEN_URL, refresh("t2"));
    await Promise.resolve();
    goTrue.answer(new Response("{}", { status: 200 }));
    await first;
    await Promise.resolve();

    const later = wrapped(TOKEN_URL, refresh("t2"));
    await Promise.resolve();
    expect(goTrue.calls()).toBe(2);
    goTrue.answer(new Response('{"code":"refresh_token_already_used"}', { status: 400 }));
    expect((await later).status).toBe(400);
  });

  it("shares a refusal with callers already waiting, and not with later ones", async () => {
    const goTrue = gotrue();
    const wrapped = singleFlightRefreshFetch(goTrue.base);

    const waiting = [wrapped(TOKEN_URL, refresh("t3")), wrapped(TOKEN_URL, refresh("t3"))];
    await Promise.resolve();
    goTrue.answer(new Response('{"code":"conflict"}', { status: 409 }));
    expect((await Promise.all(waiting)).map((response) => response.status)).toEqual([409, 409]);
    await Promise.resolve();

    const later = wrapped(TOKEN_URL, refresh("t3"));
    await Promise.resolve();
    expect(goTrue.calls()).toBe(2);
    goTrue.answer(new Response("{}", { status: 200 }));
    expect((await later).status).toBe(200);
  });

  it("shares a network failure with callers already waiting, then forgets it", async () => {
    const failing = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const wrapped = singleFlightRefreshFetch(failing as unknown as typeof fetch);

    const waiting = [wrapped(TOKEN_URL, refresh("t4")), wrapped(TOKEN_URL, refresh("t4"))];
    await expect(waiting[0]).rejects.toThrow("fetch failed");
    await expect(waiting[1]).rejects.toThrow("fetch failed");
    await expect(wrapped(TOKEN_URL, refresh("t4"))).resolves.toHaveProperty("status", 200);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("passes every other request straight through", async () => {
    const base = vi.fn(async () => new Response("[]", { status: 200 }));
    const wrapped = singleFlightRefreshFetch(base as unknown as typeof fetch);

    await Promise.all([
      wrapped("http://gotrue.test/auth/v1/user", { method: "GET" }),
      wrapped("http://gotrue.test/auth/v1/user", { method: "GET" }),
    ]);
    expect(base).toHaveBeenCalledTimes(2);
  });
});
