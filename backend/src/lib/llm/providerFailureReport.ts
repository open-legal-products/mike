import { reportError, type ReportContext } from "../observability/sentry";
import { providerFailureLevel } from "./providerErrors";

/** Preserve the failure and its context; the final transport samples repeats. */
export function reportModelFailure(failure: Error, context: ReportContext, logLabel: string): void {
  reportError(failure, { ...context, level: providerFailureLevel(failure) });
  console.error(logLabel, failure);
}
