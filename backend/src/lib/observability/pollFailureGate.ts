// Reporting policy for a background poll loop whose ticks can fail.
//
// A loop that polls every second against a database whose RPC is missing
// (migrations not applied) or unreachable fails EVERY tick, identically,
// for as long as the fault lasts. Reporting each tick filed ~3,600 Sentry
// events in 8.5 hours for two loops of one worker thread (MIKE-BACKEND-K,
// MIKE-BACKEND-P) — all of them after the first carried no new information,
// and the per-issue throttle in sentry.ts only capped the rate, it did not
// stop the flood. Hammering the broken dependency at full speed also helps
// nobody.
//
// The gate decides, per failed tick:
//   - report the FIRST failure of a class, and again whenever the class
//     changes (PGRST202 → ECONNREFUSED is new information);
//   - stay quiet for repeats, logging a one-line count at most once per
//     summary interval (console.warn: breadcrumb, never a Sentry event);
//   - back the poll interval off exponentially, bounded;
//   - on the first success after failures, log recovery once and reset.
//
// The class key is the error's name plus an allowlist-shaped `code` found on
// the error or its cause chain (PostgREST, SQLSTATE, errno). An error with no
// code is keyed by a hash of its message, so the key itself never carries
// dependency text into the log line.

const SAFE_CODE = /^[A-Za-z0-9_]{2,40}$/;
const CAUSE_DEPTH = 5;

function hashText(text: string): string {
  // FNV-1a, 32-bit: stable, cheap, and not reversible to the message.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A log-safe identity for "the same failure again". */
export function pollFailureClass(error: unknown): string {
  if (!error || typeof error !== "object") {
    return `${typeof error}#${hashText(String(error))}`;
  }
  const rawName = readField(error, "name");
  const name =
    typeof rawName === "string" && SAFE_CODE.test(rawName) ? rawName : "Error";
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const code = readField(current, "code");
    if (typeof code === "string" && SAFE_CODE.test(code)) {
      return `${name}:${code}`;
    }
    current = readField(current, "cause");
  }
  const message = readField(error, "message");
  return `${name}#${hashText(typeof message === "string" ? message : "")}`;
}

export type PollFailureVerdict = {
  /** Report this failure to Sentry (and log it at error level). */
  report: boolean;
  /** How long the loop should wait before its next attempt. */
  delayMs: number;
  /** Consecutive failed ticks, this one included. */
  consecutive: number;
};

export type PollFailureGateOptions = {
  /** Log prefix, e.g. "[dbq] claim". */
  label: string;
  /** The loop's normal interval; the first retry waits this long. */
  baseDelayMs: number | (() => number);
  /** Ceiling for the backed-off interval. */
  maxDelayMs: number;
  /** Minimum spacing of the "still failing" line. Default 60 s. */
  summaryIntervalMs?: number;
  now?: () => number;
  log?: Pick<Console, "warn" | "log">;
};

export type PollFailureGate = {
  failure(error: unknown): PollFailureVerdict;
  success(): void;
  /** False while a backed-off loop should skip its tick. */
  ready(): boolean;
  readonly failing: boolean;
};

export function createPollFailureGate(
  options: PollFailureGateOptions,
): PollFailureGate {
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  const summaryIntervalMs = options.summaryIntervalMs ?? 60_000;
  const baseDelay = () =>
    typeof options.baseDelayMs === "function"
      ? options.baseDelayMs()
      : options.baseDelayMs;

  let currentClass: string | null = null;
  let consecutive = 0;
  let quietSinceSummary = 0;
  let lastSummaryAt = 0;
  let retryAt = 0;

  return {
    failure(error) {
      const failureClass = pollFailureClass(error);
      const at = now();
      consecutive += 1;
      const base = Math.max(0, baseDelay());
      // Exponent capped so a days-long outage cannot overflow to Infinity.
      const delayMs = Math.min(
        Math.max(base, options.maxDelayMs),
        base * 2 ** Math.min(consecutive - 1, 20),
      );
      retryAt = at + delayMs;
      if (failureClass !== currentClass) {
        currentClass = failureClass;
        quietSinceSummary = 0;
        lastSummaryAt = at;
        return { report: true, delayMs, consecutive };
      }
      quietSinceSummary += 1;
      if (at - lastSummaryAt >= summaryIntervalMs) {
        log.warn(
          `${options.label} still failing (${failureClass}): ${consecutive} consecutive failures, ` +
            `${quietSinceSummary} not re-reported since the last line; next attempt in ${Math.round(delayMs / 1000)}s`,
        );
        lastSummaryAt = at;
        quietSinceSummary = 0;
      }
      return { report: false, delayMs, consecutive };
    },
    success() {
      if (currentClass !== null) {
        log.log(
          `${options.label} recovered after ${consecutive} consecutive failure(s)`,
        );
      }
      currentClass = null;
      consecutive = 0;
      quietSinceSummary = 0;
      retryAt = 0;
    },
    ready() {
      return now() >= retryAt;
    },
    get failing() {
      return currentClass !== null;
    },
  };
}
