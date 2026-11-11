// Mirrored across backend and @mike/client; sentryEvent.sync.test.ts enforces parity.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

const ISSUE_QUIET_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** One issue as Sentry groups it: our fingerprint plus the default (stack) grouping. */
function issueKey(event: RecordValue): string {
  const values = record(event.exception).values;
  const exception = Array.isArray(values) ? record(values[values.length - 1]) : {};
  const frames = record(exception.stacktrace ?? event.stacktrace).frames;
  const top = Array.isArray(frames) ? record(frames[frames.length - 1]) : {};
  return JSON.stringify([event.level ?? "error", event.fingerprint, exception.type ?? null, top.filename ?? null, top.lineno ?? null]);
}

/**
 * Sample repeated failures after privacy reconstruction. The first observation
 * of each issue/severity is always eligible; repeated warnings cannot consume
 * the capacity for a new defect or a severity escalation. This is a local
 * volume policy, not a project-wide quota or an exact count of user failures.
 */
export function eventBudget(options: { repeatEventsPerDay?: number; now?: () => number } = {}): (event: RecordValue) => boolean {
  const limit = options.repeatEventsPerDay ?? 50;
  const now = options.now ?? Date.now;
  const issues = new Map<string, { count: number; last: number }>();
  let dayStart = now();
  let repeatsToday = 0;
  return event => {
    const at = now();
    if (at - dayStart >= DAY_MS) { dayStart = at; repeatsToday = 0; }
    const key = issueKey(event);
    let issue = issues.get(key);
    if (!issue || at - issue.last >= ISSUE_QUIET_MS) issue = { count: 0, last: at };
    issue.count += 1;
    issue.last = at;
    issues.delete(key);
    issues.set(key, issue);
    // LRU bound also holds when every issue is still active.
    if (issues.size > 1_000) issues.delete(issues.keys().next().value!);
    event.tags = { ...record(event.tags), occurrence: issue.count };
    if (issue.count === 1 || record(event.tags).diagnostic_test === 'true') return true;
    if (!Number.isInteger(Math.log2(issue.count)) || repeatsToday >= limit) return false;
    repeatsToday += 1;
    return true;
  };
}

/** Explicit destinations own their volume policy; community defaults bound repeats. */
export function repeatEventLimit(raw: string | undefined, communityDestination: boolean): number {
  if (raw?.trim() && /^\d+$/.test(raw.trim())) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return communityDestination ? 50 : Infinity;
}
