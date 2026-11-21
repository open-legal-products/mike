import { createHash } from "node:crypto";

/**
 * One GoTrue refresh per refresh token, shared by every request that carries it.
 *
 * A page load fans out many API requests at once, each with the same session
 * cookie. Each request builds its own Supabase client, so when that session's
 * access token has expired, every one of them used to POST the same refresh
 * token to GoTrue. The first rotates it. The rest present a token that has just
 * been used, are refused, and clear the session cookies. The page then logs
 * itself out, or answers some of its panels with errors.
 *
 * This fetch wrapper is installed on the per-request clients. It recognises
 * the refresh call (`POST /auth/v1/token?grant_type=refresh_token`) and lets
 * one network request through for each (GoTrue URL, request body) at a time.
 * Every caller that arrives while that request is running receives its own
 * copy of its response: the same rotated session, which every request then
 * writes back as the same cookie, or the same refusal. Once it settles it is
 * forgotten, so a caller that arrives later goes to GoTrue, which decides
 * whether the old token is still good (its refresh-token reuse interval, its
 * sign-out revocation). Nothing here serves a session from memory after the
 * fact. Other requests pass through untouched.
 *
 * This is per process. Instances behind a load balancer each refresh once.
 * GoTrue may refuse the second (409 while the first is still running), and
 * that process's requests then end in a clean 401 session_expired.
 */
type Outcome = { status: number; statusText: string; headers: [string, string][]; body: string };
const inflight = new Map<string, Promise<Outcome>>();

/** The single-flight key for a refresh call, or null for any other request. */
export function refreshKey(input: Parameters<typeof fetch>[0], init?: RequestInit): string | null {
  if (init?.method !== "POST" || typeof init.body !== "string") return null;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/auth/v1/token") || url.searchParams.get("grant_type") !== "refresh_token") return null;
  // A hash, so the map never holds a refresh token in the clear.
  return createHash("sha256").update(`${url.origin}${url.pathname}\n${init.body}`).digest("hex");
}

export function singleFlightRefreshFetch(base?: typeof fetch): typeof fetch {
  // Resolved per call, so a fetch installed after import (tests, instrumentation) is used.
  const send: typeof fetch = (input, init) => (base ?? globalThis.fetch)(input, init);
  return async (input, init) => {
    const key = refreshKey(input, init);
    if (!key) return send(input, init);
    let outcome = inflight.get(key);
    if (!outcome) {
      outcome = send(input, init).then(async (response) => ({
        status: response.status,
        statusText: response.statusText,
        // The body below is already decoded; its wire framing headers no longer apply.
        headers: [...response.headers].filter(([name]) => name !== "content-encoding" && name !== "content-length"),
        body: await response.text(),
      }));
      inflight.set(key, outcome);
      const forget = () => { if (inflight.get(key) === outcome) inflight.delete(key); };
      outcome.then(forget, forget);
    }
    const result = await outcome;
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
  };
}
