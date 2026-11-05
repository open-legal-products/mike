import {
  acknowledgeUnreported,
  reportError,
  type ReportContext,
  type ReportLevel,
} from "../observability/sentry";
import { providerFailureLevel } from "./providerErrors";

/**
 * Report a failed model call at the level its provider condition deserves
 * (see providerFailureLevel), then log it. The one place that rule is
 * applied, so a chat turn, a tabular cell and a chat title agree on what a
 * rate limit or a rejected key is worth.
 *
 * `failure` should be the error the caller will rethrow or log again (an
 * AppError naming the flow, with the provider's error as its cause): the
 * console bridge recognises it, and anything wrapping it, as handled.
 * `context.level` may only make a reported failure quieter (a
 * UserFacingError the user is already shown): the quieter of it and the
 * provider's level wins, so a caller can never raise a 429 to an error, and
 * it never brings an unreported account condition back.
 */
export function reportModelFailure(
  failure: Error,
  context: ReportContext,
  logLabel: string,
): void {
  const level = providerFailureLevel(failure);
  if (level === null) {
    acknowledgeUnreported(failure);
    // console.warn: the console bridge forwards error level only, so the
    // operator keeps the line and Sentry gets nothing.
    console.warn(logLabel, failure);
    return;
  }
  reportError(failure, { ...context, level: quieter(context.level, level) });
  console.error(logLabel, failure);
}

const LOUDNESS: Record<ReportLevel, number> = { warning: 0, error: 1, fatal: 2 };

function quieter(requested: ReportLevel | undefined, level: ReportLevel): ReportLevel {
  return requested !== undefined && LOUDNESS[requested] < LOUDNESS[level] ? requested : level;
}
