// The classifier is fed what the real auth-js client returns, not
// hand-built error objects: an AuthClient whose fetch plays GoTrue (or its
// absence) for one request, so a change in how auth-js reports a status
// shows up here.
import { AuthClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { authErrorShape, isAuthUpstreamFailure } from "../authUpstream";

function goTrue(answer: () => Promise<Response>) {
  return new AuthClient({
    url: "http://gotrue.test/auth/v1",
    fetch: () => answer(),
    autoRefreshToken: false,
    persistSession: false,
  });
}

async function getUserError(answer: () => Promise<Response>) {
  const { error } = await goTrue(answer).getUser("a.b.c");
  expect(error).not.toBeNull();
  return error;
}

const json = (status: number, body: object) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("isAuthUpstreamFailure", () => {
  it("is true when GoTrue does not answer at all", async () => {
    const error = await getUserError(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(error).toMatchObject({ name: "AuthRetryableFetchError", status: 0 });
    expect(isAuthUpstreamFailure(error)).toBe(true);
  });

  it.each([502, 503, 504])("is true for a gateway %s in front of GoTrue", async (status) => {
    const error = await getUserError(json(status, { msg: "upstream" }));
    expect(isAuthUpstreamFailure(error)).toBe(true);
  });

  it("is false for a GoTrue 500 such as a broken sign-up trigger", async () => {
    const error = await getUserError(
      json(500, { code: 500, msg: "Database error saving new user" }),
    );
    // auth-js files a 500 under the same retryable class as an outage; the
    // status is what tells them apart.
    expect(error).toMatchObject({ name: "AuthRetryableFetchError", status: 500 });
    expect(isAuthUpstreamFailure(error)).toBe(false);
  });

  // auth-js retries 500-504 and 520-530 alike; only 502/503/504 (and no
  // answer) mean GoTrue is unreachable. A 501 or a Cloudflare 520/530 is an
  // answer from something that is up, and 429 is GoTrue rate-limiting us.
  it.each([500, 501, 520, 530, 429])("is false for a GoTrue %s", async (status) => {
    const error = await getUserError(json(status, { msg: "answered" }));
    expect(error).toMatchObject({ status });
    expect(isAuthUpstreamFailure(error)).toBe(false);
  });

  it("is false for a session GoTrue refused", async () => {
    const error = await getUserError(
      json(403, { code: "bad_jwt", msg: "invalid JWT" }),
    );
    expect(error).toMatchObject({ name: "AuthApiError", status: 403 });
    expect(isAuthUpstreamFailure(error)).toBe(false);
  });

  it.each([
    ["a bug in our code", new TypeError("x is undefined")],
    ["a non-auth error with a 503 status", Object.assign(new Error("x"), { status: 503 })],
    ["no error at all", null],
  ])("is false for %s", (_label, error) => {
    expect(isAuthUpstreamFailure(error)).toBe(false);
  });
});

it.each([undefined, null, "503"])("does not mistake a malformed auth status %s for an outage", (status) => {
  const error = { __isAuthError: true, name: "AuthApiError", status };
  expect(authErrorShape(error)).toEqual({ name: "AuthApiError", status: undefined });
  expect(isAuthUpstreamFailure(error)).toBe(false);
});
