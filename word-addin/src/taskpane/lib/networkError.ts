/**
 * Word's WebView reports every failed fetch — DNS, TLS, mixed content, a dead
 * dev server, a blocked origin — as the same opaque `TypeError: Load failed`
 * ("Failed to fetch" on Chromium). That tells a user nothing, so transport
 * failures are rewritten into one concise sentence.
 *
 * The sentence still names the server origin: Mike is self-hostable, and
 * "check your connection" is useless advice to someone whose own API
 * container is down. The host's original wording is kept on `cause` for the
 * console, never for the screen.
 */
import { UserVisibleError, networkMessage } from "@mike/user-error";

/** The origin a request was aimed at, for the message and for the console. */
export function requestOrigin(url: string): string {
  try {
    const base =
      typeof window !== "undefined" ? window.location.href : undefined;
    return new URL(url, base).origin;
  } catch {
    return url;
  }
}

/**
 * The one sentence shown when a request never reached the server. Pure, so
 * the wording can be asserted without a browser.
 */
export function networkErrorMessage(url: string): string {
  // The sentence itself is shared with the web app so both clients say the
  // same thing; only the origin is added here.
  return networkMessage(requestOrigin(url));
}

/** Detail about the original throw, for logs only. Never rendered. */
function errorDetail(error: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    const cause = errorDetail((error as { cause?: unknown }).cause, depth + 1);
    return `${name}${error.message}${cause ? ` — caused by ${cause}` : ""}`;
  }
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * A transport failure carrying a message that is safe to display verbatim.
 *
 * It deliberately does NOT use the name "NetworkError": `describeError`
 * treats that name as "classify and replace the message", which would drop
 * the origin. Declaring `kind: "network"` gets the same classification —
 * retryable, no support link — while keeping this wording.
 */
export class NetworkUnreachableError extends UserVisibleError {
  readonly request: { method: string; url: string };

  constructor(request: { method: string; url: string }, cause: unknown) {
    super(networkErrorMessage(request.url), {
      kind: "network",
      retryable: true,
      cause,
    });
    this.name = "NetworkUnreachableError";
    this.request = request;
  }
}

/**
 * Wrap a thrown transport failure. Logs what was actually attempted (dev
 * only) and returns the error the UI can describe.
 */
export function networkFailure(
  error: unknown,
  request: { method: string; url: string },
): NetworkUnreachableError {
  // warn, not error: the transport failure was already reported by the
  // caller, and the console bridge would turn this string into a second,
  // undifferentiated event.
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[network] ${request.method} ${request.url} failed —`,
      errorDetail(error) || error,
    );
  }
  return new NetworkUnreachableError(request, error);
}
