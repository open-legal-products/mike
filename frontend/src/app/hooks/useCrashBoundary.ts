import { useEffect } from "react";
import { isReported, reportError } from "@/app/lib/errorReporting";
import { describeError, supportMailtoFor } from "@/app/lib/userFacingError";

type CrashError = Error & { digest?: string };

/**
 * The shared half of `app/error.tsx` and `app/global-error.tsx`.
 *
 * Reports the crash once (an API 5xx that reached the boundary was already
 * reported by mikeApi under its request id, and a second event for the same
 * object only spends quota) and returns the "Contact support" email. The
 * render crashed, so nothing on the screen may echo `error.message`; the
 * digest is the only detail worth handing over, and it travels in the email.
 */
export function useCrashBoundary(
    error: CrashError,
    { component, level }: { component: string; level?: "fatal" },
): string {
    useEffect(() => {
        if (!isReported(error)) {
            reportError(error, {
                ...(level ? { level } : {}),
                tags: { component, digest: error.digest },
            });
        }
        console.error(`[${component}]`, error);
    }, [component, error, level]);

    return supportMailtoFor(
        describeError(error, { action: "load this page" }),
        `Error reference: ${error.digest ?? "unavailable"}`,
    );
}
