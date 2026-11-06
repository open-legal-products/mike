/**
 * 5xx codes the server side has already reported to Sentry, and what each
 * tells the user.
 *
 * The backend (`schema_out_of_date`, and `upstream_unavailable` when GoTrue is
 * unreachable) and the Next gateway (`upstream_unavailable` when the backend
 * is unreachable) each file one event per failure, with detail a client
 * cannot see. A client copy would be one more issue per endpoint per page
 * view for the same incident, so every client that reports 5xx answers (the
 * web app's mikeApi and authApi, the Word add-in's API client) checks this
 * table first: these codes are only marked handled, and show their own
 * sentence instead of the generic server-failure one.
 */

/**
 * The backend's answer when its database is missing a migration (PGRST202/
 * 203/204/205, 42P01, 42703). Unlike other 5xx it tells the user something actionable
 * (contact whoever runs the server).
 */
export const SCHEMA_OUT_OF_DATE_CODE = "schema_out_of_date";
export const SCHEMA_OUT_OF_DATE_MESSAGE =
    "The server's database needs an update before this can load. Please contact your administrator.";
/**
 * A dependency is unreachable: the gateway cannot reach the backend, or the
 * backend cannot reach GoTrue (503). Whoever saw it reports it once per
 * outage; the user can only wait and retry.
 */
export const UPSTREAM_UNAVAILABLE_CODE = "upstream_unavailable";
export const UPSTREAM_UNAVAILABLE_MESSAGE =
    "The server is temporarily unreachable. Please try again shortly.";

const REPORTED_UPSTREAM_MESSAGES: Readonly<Record<string, string>> = {
    [SCHEMA_OUT_OF_DATE_CODE]: SCHEMA_OUT_OF_DATE_MESSAGE,
    [UPSTREAM_UNAVAILABLE_CODE]: UPSTREAM_UNAVAILABLE_MESSAGE,
};

/**
 * The fixed user-facing message for a code the server side already
 * reported, or null for any other code (report it as usual).
 */
export function reportedUpstreamMessage(
    code: string | null | undefined,
): string | null {
    if (!code || !Object.hasOwn(REPORTED_UPSTREAM_MESSAGES, code)) return null;
    return REPORTED_UPSTREAM_MESSAGES[code] ?? null;
}
