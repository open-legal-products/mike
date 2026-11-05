/**
 * 5xx answers the server side has already reported to Sentry.
 *
 * The backend (`schema_out_of_date`, and `upstream_unavailable` when GoTrue is
 * down) and the Next gateway (`upstream_unavailable` when the backend is
 * down) each file one event per failure, with detail the browser cannot
 * see. A browser copy would be one more issue per endpoint per page view
 * for the same incident, so every client that turns a 5xx into an error
 * (mikeApi, authApi) goes through `reportServerFailure` here: these codes
 * are only marked handled, everything else is reported as before.
 */
import { markErrorHandled, reportApiFailure } from "@/app/lib/errorReporting";

/**
 * The backend's answer when its database is missing a migration (PGRST202/
 * 204/205, 42P01). Unlike other 5xx it tells the user something actionable
 * — contact whoever runs the server — so it is shown instead of the generic
 * fallback (see userFacingApiError).
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

/** The fixed user-facing message for a server-reported code, or null. */
export function reportedUpstreamMessage(code: string): string | null {
    return Object.hasOwn(REPORTED_UPSTREAM_MESSAGES, code)
        ? REPORTED_UPSTREAM_MESSAGES[code]
        : null;
}

/**
 * Report a 5xx seen by the browser, unless the server side already did.
 * An already-reported failure is only marked, so a screen's later
 * notifyError or console.error of the same error does not file it either.
 */
export function reportServerFailure(
    failure: Parameters<typeof reportApiFailure>[0],
): void {
    if (failure.code && reportedUpstreamMessage(failure.code)) {
        markErrorHandled(failure.error);
        return;
    }
    reportApiFailure(failure);
}
