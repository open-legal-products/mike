// Reporting policy for a dependency outage seen by request handlers.
//
// When GoTrue (Supabase Auth) cannot be reached, every authenticated request
// fails the same way until it comes back: one project click during a local
// outage filed five Sentry events across three issues, all saying "GoTrue is
// unreachable". Like the poll-loop gate (observability/pollFailureGate.ts),
// this keeps the first failure of a class as the one event and turns the
// repeats into a counted log line:
//
//   - report the FIRST failure of a class (no answer at all, a 502, a 503
//     ... are different classes: a change is news);
//   - while the class keeps failing, report it again at most once per
//     repeat window (15 min), so a long outage stays visible on the issue's
//     timeline without one event per request;
//   - count the quiet repeats into one console.warn at most once a minute
//     (console.warn: a breadcrumb, never a Sentry event of its own);
//   - forget everything once a later auth call succeeds: the dependency is
//     back, and the next outage is a new one, reported at once.
//
// State is per process, like the per-runtime budget in sentry.ts.

import { pollFailureClass } from "./observability/pollFailureGate";

const REPEAT_REPORT_INTERVAL_MS = 15 * 60_000;
const SUMMARY_INTERVAL_MS = 60_000;
const CAUSE_DEPTH = 5;

interface ClassState {
  reportedAt: number;
  suppressed: number;
  lineAt: number;
}
const failing = new Map<string, ClassState>();
let now: () => number = Date.now;

/**
 * A log-safe identity for "the same outage": the HTTP status auth-js saw
 * (0 = no answer) for an auth-js error anywhere in the cause chain, otherwise
 * the poll gate's name-and-code class.
 */
export function upstreamFailureClass(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") break;
    if ("__isAuthError" in current) {
      const { status } = current as { status?: unknown };
      if (typeof status === "number") return `gotrue:${status}`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return pollFailureClass(error);
}

/**
 * Should this upstream failure be sent to Sentry? Logs the counted repeat
 * line itself when it should not.
 */
export function shouldReportUpstreamFailure(error: unknown): boolean {
  const failureClass = upstreamFailureClass(error);
  const at = now();
  const state = failing.get(failureClass);
  if (!state || at - state.reportedAt >= REPEAT_REPORT_INTERVAL_MS) {
    // lineAt -Infinity: the first quiet repeat after a report gets its
    // line at once, later ones are counted into one line a minute.
    failing.set(failureClass, { reportedAt: at, suppressed: 0, lineAt: -Infinity });
    return true;
  }
  state.suppressed += 1;
  if (at - state.lineAt >= SUMMARY_INTERVAL_MS) {
    console.warn(
      `[upstream-unavailable] still failing (${failureClass}): ${state.suppressed} request(s) ` +
        `not re-reported since the last line; reported to Sentry ${Math.round((at - state.reportedAt) / 1000)}s ago`,
    );
    state.lineAt = at;
    state.suppressed = 0;
  }
  return false;
}

/** An auth call succeeded: the outage is over, the next one is news. */
export function noteUpstreamReachable(): void {
  if (failing.size === 0) return;
  console.log(
    `[upstream-unavailable] recovered (${[...failing.keys()].join(", ")})`,
  );
  failing.clear();
}

/** Test seam: forget every outage and optionally replace the clock. */
export function resetUpstreamOutagesForTests(clock: () => number = Date.now): void {
  failing.clear();
  now = clock;
}
