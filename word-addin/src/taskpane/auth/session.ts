/// <reference types="office-js" />
import { networkFailure } from "../lib/networkError";
import { responseError } from "../api/client";
import { userMessage } from "../lib/notify";
import { parseGoogleOAuthDialogMessage } from "./oauthProtocol";

const LEGACY_ACCESS_KEY = "mike_token";
const LEGACY_REFRESH_KEY = "mike_refresh_token";
const API_BASE = (process.env.REACT_APP_API_BASE_URL || "/api").replace(
  /\/+$/,
  "",
);

export interface AddinAuthUser {
  id: string;
  email: string;
  pendingEmail: string | null;
  createdWithGoogle: boolean;
}

interface SessionState {
  user: AddinAuthUser | null;
  loading: boolean;
  error: string | null;
}

let _user: AddinAuthUser | null = null;
let _loading = true;
let _error: string | null = null;
let _initialized = false;
let _sessionGeneration = 0;
let _sessionPromise: Promise<AddinAuthUser | null> | null = null;
const _subscribers = new Set<() => void>();

function broadcast(): void {
  _subscribers.forEach((subscriber) => subscriber());
}

export function subscribe(fn: () => void): () => void {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function getSessionState(): SessionState {
  return { user: _user, loading: _loading, error: _error };
}

async function clearLegacyTokenStorage(): Promise<void> {
  // Best-effort cleanup of a storage format no longer read. Nothing the user
  // asked for depends on it, so a failure stays silent.
  await Promise.all([
    OfficeRuntime.storage.removeItem(LEGACY_ACCESS_KEY).catch(() => {}),
    OfficeRuntime.storage.removeItem(LEGACY_REFRESH_KEY).catch(() => {}),
  ]);
}

// Auth routes answer with the same error envelope as the rest of the API,
// so `responseError` (api/client) is reused: the backend's 4xx `detail` is
// kept because it is written for the user, a 5xx body never is, and the
// status/code/request id ride along for `describeError` and support.

async function requestSession(): Promise<AddinAuthUser | null> {
  const url = `${API_BASE}/auth/session`;
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    throw networkFailure(error, { method: "GET", url });
  }
  if (response.status === 401) return null;
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as { user: AddinAuthUser };
  return body.user;
}

async function redeemAuthHandoff(
  ticket: string,
  requestId: string,
): Promise<AddinAuthUser> {
  const url = `${API_BASE}/auth/handoff`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, requestId }),
    });
  } catch (error) {
    throw networkFailure(error, { method: "POST", url });
  }
  if (!response.ok) throw await responseError(response);
  const body = (await response.json()) as { user: AddinAuthUser };
  return body.user;
}

export function refreshSession(): Promise<AddinAuthUser | null> {
  if (!_sessionPromise) {
    _sessionPromise = requestSession().finally(() => {
      _sessionPromise = null;
    });
  }
  return _sessionPromise.then((user) => {
    _user = user;
    _error = null;
    broadcast();
    return user;
  });
}

/**
 * Drop the pane's signed-in state locally, without calling /auth/logout.
 *
 * Used when the backend has positively said this session is gone: there is
 * nothing left to log out, and leaving `_user` populated would keep the
 * chat UI on screen while telling the user to sign in — with no gate to
 * sign in through. Bumping the generation abandons any in-flight sign-in.
 */
export function markSessionEnded(): void {
  if (_user === null) return;
  _sessionGeneration += 1;
  _user = null;
  _error = null;
  _loading = false;
  broadcast();
}

export function initialize(): void {
  if (_initialized) return;
  _initialized = true;
  void clearLegacyTokenStorage()
    .then(() => refreshSession())
    .catch((error: unknown) => {
      _user = null;
      _error = userMessage(error, {
        action: "sign in",
        fallback: "Mike couldn't sign you in. Try again.",
      });
    })
    .finally(() => {
      _loading = false;
      broadcast();
    });
}

export async function signIn(email: string, password: string): Promise<void> {
  const generation = ++_sessionGeneration;
  _loading = true;
  _error = null;
  broadcast();
  const url = `${API_BASE}/auth/login`;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (error) {
      throw networkFailure(error, { method: "POST", url });
    }
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { user: AddinAuthUser };
    if (generation !== _sessionGeneration) return;
    _user = body.user;
  } catch (error) {
    if (generation !== _sessionGeneration) return;
    _user = null;
    _error = userMessage(error, {
      action: "sign in",
      fallback: "Mike couldn't sign you in. Try again.",
      codeMessages: {
        invalid_credentials: "That email and password don't match an account.",
      },
    });
  } finally {
    if (generation === _sessionGeneration) {
      _loading = false;
      broadcast();
    }
  }
}

function createOAuthRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function signInWithGoogle(): Promise<void> {
  const generation = ++_sessionGeneration;
  const requestId = createOAuthRequestId();
  const expectedOrigin = window.location.origin;
  const dialogUrl = new URL("/oauth-dialog.html", expectedOrigin);
  dialogUrl.searchParams.set("requestId", requestId);
  _loading = true;
  _error = null;
  broadcast();

  await new Promise<void>((resolve) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      if (generation === _sessionGeneration) {
        _error = message;
        broadcast();
      }
      resolve();
    };

    try {
      Office.context.ui.displayDialogAsync(
        dialogUrl.toString(),
        { height: 60, width: 45, displayInIframe: false },
        (result) => {
          if (result.status !== Office.AsyncResultStatus.Succeeded) {
            fail(result.error?.message ?? "Unable to open Google sign-in.");
            return;
          }
          const dialog = result.value;
          const close = (): void => {
            try {
              dialog.close();
            } catch {
              // The host may already have closed the dialog; nothing to say.
            }
          };

          dialog.addEventHandler(
            Office.EventType.DialogMessageReceived,
            (event) => {
              if (settled || !("message" in event)) return;
              if (event.origin && event.origin !== expectedOrigin) {
                close();
                fail("Google sign-in returned from an unexpected origin.");
                return;
              }
              const message = parseGoogleOAuthDialogMessage(event.message);
              if (!message || message.requestId !== requestId) {
                close();
                fail("Google sign-in returned an invalid response.");
                return;
              }
              if (message.status === "error") {
                close();
                // Written by our own OAuth dialog page, already user-facing.
                fail(message.message);
                return;
              }

              settled = true;
              close();
              void redeemAuthHandoff(message.handoffTicket, requestId)
                .then((user) => {
                  if (generation === _sessionGeneration) {
                    _user = user;
                    _error = null;
                  }
                })
                .catch((error: unknown) => {
                  if (generation === _sessionGeneration) {
                    _error = userMessage(error, {
                      action: "complete Google sign-in",
                      fallback: "Mike couldn't complete Google sign-in.",
                    });
                  }
                })
                .finally(() => {
                  if (generation === _sessionGeneration) _loading = false;
                  broadcast();
                  resolve();
                });
            },
          );

          dialog.addEventHandler(
            Office.EventType.DialogEventReceived,
            (event) => {
              if (!("error" in event)) return;
              fail(
                event.error === 12006
                  ? "Google sign-in was cancelled."
                  : `Google sign-in closed unexpectedly (Office error ${event.error}).`,
              );
            },
          );
        },
      );
    } catch (error) {
      // Office.js throws host text here ("The dialog box has been directed
      // to a URL..."), which means nothing to a user.
      fail(
        userMessage(error, {
          fallback: "Mike couldn't open Google sign-in. Try again.",
        }),
      );
    }
  }).finally(() => {
    if (generation === _sessionGeneration && _loading) {
      _loading = false;
      broadcast();
    }
  });
}

export async function signOut(): Promise<void> {
  _sessionGeneration += 1;
  _error = null;
  const url = `${API_BASE}/auth/logout`;
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "local" }),
      });
    } catch (error) {
      throw networkFailure(error, { method: "POST", url });
    }
    if (!response.ok) throw await responseError(response);
    _user = null;
    await clearLegacyTokenStorage();
  } catch (error) {
    _error = userMessage(error, {
      action: "sign out",
      fallback: "Mike couldn't sign you out. Try again.",
    });
  }
  broadcast();
}
