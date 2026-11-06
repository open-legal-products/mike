import { AppError } from "./appError";
import { SCHEMA_OUT_OF_DATE_CODE, schemaOutOfDateLink } from "./httpError";
import { reportError } from "./observability/sentry";

// One Sentry event per process per key: a database behind this build stays
// behind until an operator migrates it, so every later failure for the same
// key is the same fact, not news (MIKE-BACKEND-3Z reached 64 occurrences on
// one process, one per stale-work sweep). The log keeps reminding, at most
// once an hour per key, so an operator who missed the first line still sees
// that the install is broken without a restart.
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

const MIGRATE_HINT =
  "Run `backend/scripts/migrate.sh status`, then `backend/scripts/migrate.sh up`, " +
  "and reload the PostgREST schema cache (NOTIFY pgrst, 'reload schema'). " +
  "See docs/deployment.md.";

interface KeyState {
  lastLoggedAt: number;
  sinceLastLog: number;
}
const reported = new Map<string, KeyState>();

/**
 * Report a schema-out-of-date failure (a function, table or column this
 * build needs is missing: the same codes `sendInternalError` answers 503
 * `schema_out_of_date` for) once per process per `key`, at error level so
 * the project's alert rule fires, under the `schema_out_of_date` kind. Later
 * failures for the key file no event; a `console.warn` reminder with their
 * count is logged at most once an hour.
 *
 * Returns true when `error` was such a failure and has been handled (the
 * caller should not report it again), false when it is anything else and
 * the caller's usual reporting applies.
 *
 * Use it on background paths (timers, best-effort side effects) where the
 * same missing object would otherwise be reported on every run. A request
 * handler should keep using sendInternalError, which already answers 503.
 */
export function reportSchemaOutOfDateOnce(
  error: unknown,
  options: {
    key: string;
    tags?: Record<string, string>;
    /** What stays broken meanwhile, appended to both log lines. */
    consequence?: string;
  },
): boolean {
  const failure = schemaOutOfDateLink(error);
  if (!failure) return false;
  const { code, link } = failure;
  const consequence = options.consequence ? `; ${options.consequence}` : "";
  const now = Date.now();
  const state = reported.get(options.key);
  if (state) {
    state.sinceLastLog++;
    if (now - state.lastLoggedAt >= REMINDER_INTERVAL_MS) {
      console.warn(
        `[schema-out-of-date] ${options.key}: still failing (${code})${consequence}; ` +
          `${state.sinceLastLog} more failure(s) since the last log line. ${MIGRATE_HINT}`,
      );
      state.lastLoggedAt = now;
      state.sinceLastLog = 0;
    }
    return true;
  }
  reported.set(options.key, { lastLoggedAt: now, sinceLastLog: 0 });
  reportError(
    new AppError(
      SCHEMA_OUT_OF_DATE_CODE,
      `The database is missing an object this build needs (${code})`,
      // The coded link, not the whole chain: the privacy boundary names an
      // event after the deepest AppError kind, so a wrapper such as
      // db.query_failed below this one would otherwise win over
      // schema_out_of_date. failure_code still comes from this link.
      { cause: link },
    ),
    { level: "error", tags: options.tags },
  );
  // console.warn: the console bridge forwards console.error only, and this
  // failure has just been reported.
  console.warn(
    `[schema-out-of-date] ${options.key}: the database is missing an object this build needs (${code})${consequence}. ` +
      `${MIGRATE_HINT} Further failures of this kind are not reported to Sentry again until restart; ` +
      "this log line repeats at most once an hour while they continue.",
  );
  return true;
}

/** Test seam: forget which keys were reported. */
export function resetSchemaOutOfDateReportsForTests(): void {
  reported.clear();
}
