import { AppError } from "./appError";
import { SCHEMA_OUT_OF_DATE_CODE, schemaOutOfDateLink } from "./httpError";
import { reportError } from "./observability/sentry";

// Keys already reported by this process. A database that is behind this
// build stays behind until an operator migrates it, so every later failure
// for the same key is the same fact, not news: one Sentry event per process
// per key is the signal, the rest is noise (MIKE-BACKEND-3Z reached 64
// occurrences on one process, one per stale-work sweep).
const reported = new Set<string>();

/**
 * Report a schema-out-of-date failure (a function, table or column this
 * build needs is missing: the same codes `sendInternalError` answers 503
 * `schema_out_of_date` for) once per process per `key`, at warning level,
 * under the `schema_out_of_date` kind.
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
  options: { key: string; tags?: Record<string, string> },
): boolean {
  const failure = schemaOutOfDateLink(error);
  if (!failure) return false;
  const { code, link } = failure;
  if (reported.has(options.key)) return true;
  reported.add(options.key);
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
    { level: "warning", tags: options.tags },
  );
  // console.warn: the console bridge forwards console.error only, and this
  // failure has just been reported.
  console.warn(
    `[schema-out-of-date] ${options.key}: the database is missing an object this build needs (${code}). ` +
      "Run `backend/scripts/migrate.sh status`, then `backend/scripts/migrate.sh up`, " +
      "and reload the PostgREST schema cache (NOTIFY pgrst, 'reload schema'). " +
      "See docs/deployment.md. Further failures of this kind are not reported again until restart.",
  );
  return true;
}

/** Test seam: forget which keys were reported. */
export function resetSchemaOutOfDateReportsForTests(): void {
  reported.clear();
}
