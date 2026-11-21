import { AppError } from "./appError";
import { reportError, type ReportContext } from "./observability/sentry";

export { SCHEMA_OUT_OF_DATE_CODE } from "./reportedUpstreamCodes";
import { SCHEMA_OUT_OF_DATE_CODE } from "./reportedUpstreamCodes";

// Codes that mean "the database schema is behind this build": the code asked
// for a function, table or column the database does not have. On a
// self-hosted install that is almost always migrations that were never
// applied (or PostgREST's schema cache not reloaded after they were), not a
// transient fault, so retrying cannot help and the operator, not the user,
// has to act.
//
// 42703 (undefined column) and PGRST203 (an RPC that matches more than one
// overload) are included by maintainer decision: on a self-hosted install
// they are almost always a column or a replaced function signature from a
// migration that has not run (main's login-MFA preference lookup already
// treated 42703 that way). They are not always that: a column typo in a
// query, a dynamically built statement naming a column by item kind, or a
// migration that forgot to drop an old overload lands here too, and the
// background sweeps are tested against mocked supabase only, so CI does not
// catch such a bug for them. If `migrate.sh status` shows nothing pending,
// a schema_out_of_date event is a bug to report (docs/deployment.md). 42883
// stays an ordinary 500: Postgres raises it for operator and type
// mismatches in a query too, not only for a missing function.
const SCHEMA_OUT_OF_DATE_CODES = new Set([
  "PGRST202", // function not found in the schema cache
  "PGRST203", // ambiguous overloaded function (old and new signature both present)
  "PGRST204", // column not found in the schema cache
  "PGRST205", // table not found in the schema cache
  "42P01", // undefined_table
  "42703", // undefined_column
]);

/**
 * The link of an error's cause chain that carries a schema-drift code, and
 * that code. Reads only the structured `code` of each link (a supabase-js
 * error object, or the Error asReportableError wrapped around one), never
 * message text.
 */
export function schemaOutOfDateLink(
  error: unknown,
): { code: string; link: object } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    try {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && SCHEMA_OUT_OF_DATE_CODES.has(code)) {
        return { code, link: current };
      }
      current = (current as { cause?: unknown }).cause;
    } catch {
      return null;
    }
  }
  return null;
}

/** The schema-drift code in an error's cause chain, if any. */
export function schemaOutOfDateCode(error: unknown): string | null {
  return schemaOutOfDateLink(error)?.code ?? null;
}


// One Sentry event per process per key: a database behind this build stays
// behind until an operator migrates it, so every later failure for the same
// key is the same fact, not news (MIKE-BACKEND-3Z reached 64 occurrences on
// one process, one per stale-work sweep). The log keeps reminding, at most
// once an hour per key, so an operator who missed the first line still sees
// that the install is broken without a restart.
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/** The operator's next step, in every schema-drift log line (request or background). */
const MIGRATE_HINT =
  "Run `backend/scripts/migrate.sh status`, then `backend/scripts/migrate.sh up`, " +
  "and reload the PostgREST schema cache (NOTIFY pgrst, 'reload schema'). " +
  "If nothing is pending, this is a bug: report it. See docs/deployment.md.";

interface KeyState {
  lastLoggedAt: number;
  sinceLastLog: number;
}
const reported = new Map<string, KeyState>();

/**
 * The once-per-process-per-key gate on its own: null when `error` is not a
 * schema-drift failure; otherwise its code and coded link, and `report:
 * true` only for the first failure of `key` in this process. Logs the
 * operator lines itself (the first, then a counted reminder at most once an
 * hour). The caller sends the event when `report` is true.
 *
 * sendInternalError uses it keyed by `http:<method> <route pattern>` so a
 * request path keeps its own event shape (the original error, its stack and
 * http tags) under the same "one event per drift per process" rule.
 */
export function gateSchemaOutOfDate(
  error: unknown,
  options: {
    key: string;
    /** What stays broken meanwhile, appended to both log lines. */
    consequence?: string;
  },
): { code: string; link: object; report: boolean } | null {
  const failure = schemaOutOfDateLink(error);
  if (!failure) return null;
  const { code } = failure;
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
    return { ...failure, report: false };
  }
  reported.set(options.key, { lastLoggedAt: now, sinceLastLog: 0 });
  // console.warn: the console bridge forwards console.error only, and the
  // caller reports this failure.
  console.warn(
    `[schema-out-of-date] ${options.key}: the database is missing an object this build needs (${code})${consequence}. ` +
      `${MIGRATE_HINT} Further failures of this kind are not reported to Sentry again until restart; ` +
      "this log line repeats at most once an hour while they continue.",
  );
  return { ...failure, report: true };
}

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
 * same missing object would otherwise be reported on every run. Request
 * handlers keep using sendInternalError, which answers 503 and applies the
 * same gate (gateSchemaOutOfDate above).
 */
export function reportSchemaOutOfDateOnce(
  error: unknown,
  options: {
    key: string;
    tags?: ReportContext["tags"];
    /** What stays broken meanwhile, appended to both log lines. */
    consequence?: string;
  },
): boolean {
  const failure = gateSchemaOutOfDate(error, options);
  if (!failure) return false;
  if (!failure.report) return true;
  reportError(
    new AppError(
      SCHEMA_OUT_OF_DATE_CODE,
      `The database is missing an object this build needs (${failure.code})`,
      // The coded link, not the whole chain: the privacy boundary names an
      // event after the deepest AppError kind, so a wrapper such as
      // db.query_failed below this one would otherwise win over
      // schema_out_of_date. failure_code still comes from this link.
      { cause: failure.link },
    ),
    { level: "error", tags: options.tags },
  );
  return true;
}

/** Test seam: forget which keys were reported. */
export function resetSchemaOutOfDateReportsForTests(): void {
  reported.clear();
}
