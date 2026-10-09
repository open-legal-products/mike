/**
 * Retry-once loader for the composer's preflight requests (API key status and
 * user profile). Word's WKWebView drops requests often enough that a single
 * failed fetch used to leave the composer stuck on "No API Key" until the
 * pane reloaded; one retry with a short backoff absorbs the common transient,
 * and a final failure resolves to null so callers can fail open instead of
 * blocking sends the backend would accept.
 */
export async function loadWithRetry<T>(
  load: () => Promise<T>,
  options: {
    retries?: number;
    delayMs?: number;
    onFinalFailure?: (error: unknown) => void;
  } = {},
): Promise<T | null> {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 750;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
    try {
      return await load();
    } catch (error) {
      // Held, not swallowed: the last failure is handed to onFinalFailure so
      // the caller can classify it and tell the user.
      lastError = error;
    }
  }
  options.onFinalFailure?.(lastError);
  return null;
}
