/** Ownership is explicit; a status or display code never establishes it. */
export const BACKEND_REPORTING_OWNER = "backend";

/**
 * Fixed public messages for upstream failure codes. Reporting ownership is
 * carried separately by reporting_owner; a known code never proves handling.
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
 * The fixed user-facing message for a known upstream failure code, or null.
 */
export function reportedUpstreamMessage(
    code: string | null | undefined,
): string | null {
    if (!code || !Object.hasOwn(REPORTED_UPSTREAM_MESSAGES, code)) return null;
    return REPORTED_UPSTREAM_MESSAGES[code] ?? null;
}
