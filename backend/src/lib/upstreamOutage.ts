// Reporting policy for a dependency outage seen by request handlers.
//
// When GoTrue (Supabase Auth) cannot be reached, every authenticated request
// fails the same way until it comes back: one project click during a local
// outage filed five Sentry events across three issues, all saying "GoTrue is
// unreachable". This is the poll-loop gate (observability/pollFailureGate.ts)
// applied to requests, with no backoff (a request cannot wait) and two
// options:
//
//   - classify by the HTTP status auth-js saw (0 = no answer, 502, 503, 504):
//     a change of class is news, reported at once;
//   - while a class keeps failing, report it again once per 15 minutes, so a
//     long outage stays visible on the issue's timeline without one event per
//     request. Quiet repeats are counted into one console.warn a minute (a
//     breadcrumb, never a Sentry event of its own).
//
// A flapping GoTrue (some requests succeed, some fail, interleaved) is the
// gate's flap rule: a class reported within the last 15 minutes is a repeat
// even after a success in between, so 50% failures for an hour files one
// event per 15 minutes, not one per failed request. A success ends the
// streak; an outage that returns more than 15 minutes after its last report
// is news again, and so is any other class.
//
// State is per process (per replica), like the per-runtime budget in
// sentry.ts.

import { createPollFailureGate, pollFailureClass } from "./observability/pollFailureGate";

const REPEAT_WINDOW_MS = 15 * 60_000;
const CAUSE_DEPTH = 5;

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

function createGate(now: () => number) {
  return createPollFailureGate({
    label: "[upstream-unavailable]",
    baseDelayMs: 0,
    maxDelayMs: 0,
    classify: upstreamFailureClass,
    repeatReportIntervalMs: REPEAT_WINDOW_MS,
    repeatWhilePersistingMs: REPEAT_WINDOW_MS,
    now,
  });
}

let gate = createGate(Date.now);

/**
 * Should this upstream failure be sent to Sentry? Logs the counted repeat
 * line itself when it should not.
 */
export function shouldReportUpstreamFailure(error: unknown): boolean {
  return gate.failure(error).report;
}

/** An auth call succeeded: the current failure streak is over. */
export function noteUpstreamReachable(): void {
  gate.success();
}

/** Test seam: forget every outage and optionally replace the clock. */
export function resetUpstreamOutagesForTests(clock: () => number = Date.now): void {
  gate = createGate(clock);
}
