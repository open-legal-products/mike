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
import { reportedUpstreamMessage } from "@mike/client";

// The code table is shared with the Word add-in (packages/client); it is
// re-exported here so web callers keep one import.
export {
    SCHEMA_OUT_OF_DATE_CODE,
    SCHEMA_OUT_OF_DATE_MESSAGE,
    UPSTREAM_UNAVAILABLE_CODE,
    UPSTREAM_UNAVAILABLE_MESSAGE,
    reportedUpstreamMessage,
} from "@mike/client";

/**
 * Report a 5xx seen by the browser, unless the server side already did.
 * An already-reported failure is only marked, so a screen's later
 * notifyError or console.error of the same error does not file it either.
 */
export function reportServerFailure(
    failure: Parameters<typeof reportApiFailure>[0],
): void {
    if (reportedUpstreamMessage(failure.code)) {
        markErrorHandled(failure.error);
        return;
    }
    reportApiFailure(failure);
}
