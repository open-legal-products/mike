/**
 * Is this auth-js failure GoTrue (Supabase Auth) being unreachable, rather
 * than a refusal or a bug on our side?
 *
 * auth-js reports two different things through the same error classes:
 *
 * - No response at all (connection refused, DNS, reset, timeout): an
 *   AuthRetryableFetchError with status 0.
 * - An HTTP answer in its "network error" list (500-504, 520-530): also an
 *   AuthRetryableFetchError, carrying that status.
 *
 * Only "no response" and the gateway statuses 502, 503 and 504 mean GoTrue
 * could not be reached or is overloaded, which the user can only wait out.
 * A GoTrue 500 is GoTrue running and failing on something of ours, for
 * example "Database error saving new user" when an auth.users trigger or a
 * missing migration breaks sign-up. That is our bug: it stays a reported 500,
 * and the user is not told to "try again shortly".
 *
 * Callers answer an upstream failure with 503 `upstream_unavailable`, the
 * same code the Next gateway uses when it cannot reach this server, and never
 * as a refused session: a GoTrue outage must not sign anyone out.
 *
 * Duck-typed on auth-js's `__isAuthError` marker and numeric `status` so it
 * accepts errors from any auth-js copy (supabase-js, @supabase/ssr) and has
 * no imports: lib/ and middleware/ may use it, and the file is shared
 * byte-for-byte between branches that need it.
 */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export function isAuthUpstreamFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("__isAuthError" in error)) {
    return false;
  }
  const { status } = error as { status?: unknown };
  return typeof status === "number" && UNREACHABLE_STATUSES.has(status);
}
