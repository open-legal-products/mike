/**
 * What a failed session refresh actually means.
 *
 * When an API call comes back 401 the pane asks the backend to refresh the
 * cookie session. That refresh can end three very different ways, and they
 * were previously collapsed into one: "Your session has expired. Sign in
 * again." A user on a dropped Wi-Fi link was told to sign in, while the pane
 * stayed signed in and offered nothing to click.
 *
 * Pure, so each rule can be asserted without a network.
 */
import { isNetworkError, isOffline, isTimeoutError } from "@mike/user-error";

export type SessionRefreshOutcome =
  /** The session came back. Re-run the request that got the 401. */
  | { kind: "refreshed" }
  /** The refresh itself was rejected. Sign the pane out and show the gate. */
  | { kind: "expired" }
  /** The refresh never got an answer. Nothing is known about the session. */
  | { kind: "unreachable" };

/** Shown for `unreachable`. The session may well still be perfectly good. */
export const SESSION_CHECK_FAILED_MESSAGE =
  "Couldn't check your session. Check your connection and try again.";

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Classify the result of `refreshSession()`.
 *
 * - Resolved with a user: the session is alive.
 * - Resolved with `null`: the refresh endpoint answered 401, i.e. the
 *   backend positively says this session is gone.
 * - Threw 401/403: same — the server answered, and its answer was "no".
 * - Threw anything else (transport, offline, timeout, a 5xx, a parse
 *   failure): the server never gave a verdict. Refusing to guess is the
 *   whole point; "sign in again" would be a fabrication.
 */
export function classifySessionRefresh(
  result:
    | { ok: true; user: unknown }
    | { ok: false; error: unknown },
): SessionRefreshOutcome {
  if (result.ok) {
    return result.user ? { kind: "refreshed" } : { kind: "expired" };
  }
  const { error } = result;
  if (isOffline() || isNetworkError(error) || isTimeoutError(error)) {
    return { kind: "unreachable" };
  }
  const status = statusOf(error);
  if (status === 401 || status === 403) return { kind: "expired" };
  return { kind: "unreachable" };
}

/**
 * The `fetch` the pane uses for every API call: on a 401 it refreshes the
 * cookie session and acts on what the refresh actually said.
 *
 * - Refreshed: re-run the original request ONCE, so the caller gets the
 *   answer it asked for instead of a permission error the user never caused.
 *   Exactly once, so a backend that 401s everything cannot become a loop.
 * - Expired: hand back the original 401 and let the caller sign the pane out
 *   and say so — there is a login gate to click.
 * - Unreachable: hand back the original 401, but say the session could not
 *   be CHECKED. Claiming it expired would be a guess, and the pane is
 *   probably still signed in.
 *
 * Dependency-injected so the retry can be asserted with a stub fetch.
 */
export function createRefreshingFetch(deps: {
  fetchImpl: typeof fetch;
  refreshSession: () => Promise<unknown>;
  onExpired: () => void;
  onUnreachable: () => void;
}): typeof fetch {
  return async (input, init) => {
    const send = (): Promise<Response> =>
      deps.fetchImpl(input, { ...init, credentials: "include" });
    const response = await send();
    if (response.status !== 401) return response;

    const outcome = await deps.refreshSession().then(
      (user) => classifySessionRefresh({ ok: true, user }),
      (error: unknown) => classifySessionRefresh({ ok: false, error }),
    );

    if (outcome.kind === "refreshed") {
      // `init.body` is a string or FormData at every add-in call site, so
      // the request is replayable.
      return send();
    }
    if (outcome.kind === "expired") {
      deps.onExpired();
      return response;
    }
    deps.onUnreachable();
    return response;
  };
}
