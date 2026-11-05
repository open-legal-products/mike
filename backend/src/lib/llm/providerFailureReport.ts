import {
  acknowledgeUnreported,
  reportError,
  type ReportContext,
  type ReportLevel,
} from "../observability/sentry";
import { deploymentKeyRefusal, providerFailureLevel } from "./providerErrors";

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
  const level = modelFailureReportLevel(failure);
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

/** Deployment-key refusals already reported by this process. */
const reportedDeploymentRefusals = new Set<string>();

/**
 * providerFailureLevel, with one more rule: the provider refusing the
 * DEPLOYMENT'S key (rejected, or no credit) is reported once per process per
 * provider and condition, and null after that. A revoked deployment key fails
 * every turn, title, cell and curator run until the operator replaces it,
 * and each would otherwise be another event against the monthly quota for
 * the one thing the first already said. Replacing the key means a restart,
 * which re-arms the report. Every surface that reports a model failure asks
 * here, so they share the one report.
 */
export function modelFailureReportLevel(error: unknown): "warning" | "error" | null {
  const level = providerFailureLevel(error);
  if (level === null) return null;
  const refusal = deploymentKeyRefusal(error);
  if (!refusal) return level;
  const key = `${refusal.provider}:${refusal.kind}`;
  if (reportedDeploymentRefusals.has(key)) return null;
  reportedDeploymentRefusals.add(key);
  return level;
}

/** Test seam: forget which deployment-key refusals were reported. */
export function resetDeploymentRefusalReportsForTests(): void {
  reportedDeploymentRefusals.clear();
}

const LOUDNESS: Record<ReportLevel, number> = { warning: 0, error: 1, fatal: 2 };

function quieter(requested: ReportLevel | undefined, level: ReportLevel): ReportLevel {
  return requested !== undefined && LOUDNESS[requested] < LOUDNESS[level] ? requested : level;
}
