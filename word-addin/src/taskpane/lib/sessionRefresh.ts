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

/** Shown for `expired`, by the toast and by any screen that failed on it. */
export const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Sign in again to continue.";

/**
 * Codes the API client gives the error for a 401 this layer has already
 * dealt with. The session toast (or the login gate) already told the user
 * what happened, so the request's own `{"detail":"Not authenticated"}` must
 * not reach the screen as a second notice or as a screen's error text.
 */
export const SESSION_ERROR_CODES = {
  expired: "session_expired",
  unreachable: "session_unreachable",
} as const;

const SESSION_ERROR_MESSAGES = {
  expired: SESSION_EXPIRED_MESSAGE,
  unreachable: SESSION_CHECK_FAILED_MESSAGE,
} as const;

type HandledOutcome = keyof typeof SESSION_ERROR_CODES;

const handledResponses = new WeakMap<Response, HandledOutcome>();

/**
 * The code and sentence for a 401 response this layer handled, or `null`
 * for any other response. Read by the API client's `responseError`.
 */
export function sessionHandledError(
  response: Response,
): { code: string; message: string } | null {
  const outcome = handledResponses.get(response);
  if (!outcome) return null;
  return {
    code: SESSION_ERROR_CODES[outcome],
    message: SESSION_ERROR_MESSAGES[outcome],
  };
}

/** True for an error (or its description) built from a handled 401. */
export function isSessionHandledError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === SESSION_ERROR_CODES.expired ||
    code === SESSION_ERROR_CODES.unreachable
  );
}

/*
 * After an unreachable check, the screens that failed on that 401 are
 * stale. When the user's "Retry" on the session toast brings the session
 * back, they load again by themselves instead of keeping the old error.
 */
const pendingRetries = new Set<() => void | Promise<void>>();
const recoveryListeners = new Set<() => void>();

/** Run `retry` once, the next time the session recovers. */
export function retryWhenSessionRecovers(
  retry: () => void | Promise<void>,
): void {
  pendingRetries.add(retry);
}

/** Call `listener` every time the session recovers. Returns the unsubscribe. */
export function onSessionRecovered(listener: () => void): () => void {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}

/** The session check succeeded again: reload whatever failed on it. */
export function announceSessionRecovered(): void {
  const retries = [...pendingRetries];
  pendingRetries.clear();
  for (const retry of retries) {
    void Promise.resolve()
      .then(retry)
      .catch((error: unknown) =>
        console.warn("[session] reload after recovery failed", error),
      );
  }
  for (const listener of [...recoveryListeners]) listener();
}

/** The session is gone: nothing that failed on it should reload later. */
export function forgetSessionRecoveryRetries(): void {
  pendingRetries.clear();
}

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

function isReplayable(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): boolean {
  if (typeof Request !== "undefined" && input instanceof Request) return false;
  const body = init?.body;
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
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
      // Replaying a POST/PATCH/DELETE is safe only because the backend never
      // answers 401 after doing work: every 401 comes from requireAuth
      // (backend/src/middleware/auth.ts) or the cookie check that opens each
      // /auth handler (cookieClient in backend/src/modules/auth/
      // auth.routes.ts), before any write. A route that 401s after a side
      // effect would break this; such a route must use 403 instead.
      //
      // The body must also be re-sendable. Strings, FormData and Blob/File
      // (upload PUTs) are; a stream was consumed by the first attempt and a
      // Request object carries its own consumed body, so those get the 401
      // back with the session already refreshed — the caller's own Retry
      // then succeeds instead of a second request silently going out empty.
      if (!isReplayable(input, init)) return response;
      return send();
    }
    if (outcome.kind === "expired") {
      handledResponses.set(response, "expired");
      deps.onExpired();
      return response;
    }
    handledResponses.set(response, "unreachable");
    deps.onUnreachable();
    return response;
  };
}
