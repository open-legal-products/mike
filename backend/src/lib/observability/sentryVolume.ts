// Mirrored across backend and @mike/client; sentryEvent.sync.test.ts enforces parity.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

const ISSUE_QUIET_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_TRACKED_ISSUES = 1_000;

/** Pinned fingerprints replace stack grouping; severity retains a separate allowance. */
function issueKey(event: RecordValue): string {
  const fingerprint = event.fingerprint;
  // The privacy boundary has already produced a controlled fingerprint. Use
  // its grouping semantics, without maintaining a second list of pinned names.
  if (Array.isArray(fingerprint) && fingerprint.length && !fingerprint.includes("{{ default }}")) {
    return JSON.stringify([event.level ?? "error", fingerprint]);
  }
  const values = record(event.exception).values;
  const exception = Array.isArray(values) ? record(values[values.length - 1]) : {};
  const frames = record(exception.stacktrace ?? event.stacktrace).frames;
  const top = Array.isArray(frames) ? record(frames[frames.length - 1]) : {};
  return JSON.stringify([event.level ?? "error", event.fingerprint, exception.type ?? null, top.filename ?? null, top.lineno ?? null]);
}

/**
 * Sample repeated failures after privacy reconstruction. The first observation
 * of each issue/severity bypasses the repeat allowance, but every accepted
 * event consumes the hard daily ceiling. Daily identities survive quiet resets
 * and occurrence-cache eviction. Once the daily identity cache is full, unknown
 * keys use the repeat allowance conservatively until the next day. Shared
 * projects accept at most 50 events, so their identity cache cannot fill.
 * This is a local budget, not a project-wide quota or an impact count.
 */
export function eventBudget(options: { repeatEventsPerDay?: number; eventsPerDay?: number; now?: () => number } = {}): (event: RecordValue) => boolean {
  const limit = options.repeatEventsPerDay ?? 25;
  const ceiling = options.eventsPerDay ?? 50;
  const now = options.now ?? Date.now;
  const issues = new Map<string, { count: number; last: number }>();
  const reportedToday = new Set<string>();
  let ceilingNoticeLogged = false;
  let dayStart = now();
  let repeatsToday = 0;
  let eventsToday = 0;
  return event => {
    const at = now();
    if (at - dayStart >= DAY_MS) {
      dayStart = at;
      repeatsToday = 0;
      eventsToday = 0;
      reportedToday.clear();
      ceilingNoticeLogged = false;
    }
    const key = issueKey(event);
    let issue = issues.get(key);
    if (!issue || at - issue.last >= ISSUE_QUIET_MS) issue = { count: 0, last: at };
    issue.count += 1;
    issue.last = at;
    issues.delete(key);
    issues.set(key, issue);
    // LRU bound also holds when every issue is still active.
    if (issues.size > MAX_TRACKED_ISSUES) issues.delete(issues.keys().next().value!);
    event.tags = { ...record(event.tags), occurrence: issue.count };
    if (eventsToday >= ceiling) {
      if (!ceilingNoticeLogged) {
        ceilingNoticeLogged = true;
        // Fixed local text only: no event data, and warn is not captured by
        // Mike's error-only console bridge. Set the guard before logging.
        console.warn("[sentry] Daily event limit reached; further reports are suppressed until the next reporting day.");
      }
      return false;
    }
    const probe = record(event.tags).diagnostic_test === 'true';
    const firstToday = !reportedToday.has(key) && reportedToday.size < MAX_TRACKED_ISSUES;
    if (!firstToday && !probe) {
      if (!Number.isInteger(Math.log2(issue.count)) || repeatsToday >= limit) return false;
      repeatsToday += 1;
    }
    if (firstToday) reportedToday.add(key);
    eventsToday += 1;
    return true;
  };
}

/** Shared projects reserve half their ceiling for new failures and escalations. */
export function repeatEventLimit(raw: string | undefined, communityDestination: boolean): number {
  let value = communityDestination ? 25 : Infinity;
  if (raw?.trim() && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) value = parsed;
  }
  return communityDestination ? Math.min(value, 25) : value;
}

/** Match the actual project, including explicit configuration or a rotated key. */
function destination(dsn: string): string | null {
  try {
    const url = new URL(dsn);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}

export function eventBudgetLimits(raw: string | undefined, dsn: string, communityDsns: readonly string[]): { repeatEventsPerDay: number; eventsPerDay: number } {
  const target = destination(dsn);
  const community = target !== null && communityDsns.some(known => destination(known) === target);
  return { repeatEventsPerDay: repeatEventLimit(raw, community), eventsPerDay: community ? 50 : Infinity };
}
