// Business logic + data-access for the audit module.
//
// Service layer behind audit.routes.ts. Both functions take an explicit
// Supabase client (`db`) plus request-derived primitives, parse the caller's
// filter, run the visibility-scoped query, and RETURN a `ServiceResult`.
// They never touch req/res.
//
// The query/CSV primitives themselves live in lib/auditExport because the
// async "audit-csv" export job reuses them; they are re-exported by name here
// so the module's facade is the one door into the audit surface.

import type { Db } from "../../lib/supabase";
import {
  AUDIT_CSV_FILENAME,
  AUDIT_EXPORT_LIMIT,
  buildAuditCsv,
  parseQuery,
  queryEvents,
} from "../../lib/auditExport";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

export {
  accessibleProjectIds,
  buildAuditCsv,
  csvCell,
  escapeLikePattern,
  parseQuery,
  queryEvents,
} from "../../lib/auditExport";
export type { AuditQuery, ParseQueryResult } from "../../lib/auditExport";

export const PAGE_SIZE = 50;

export type AuditPage = {
  events: unknown[];
  total: number;
  page: number;
  pageSize: number;
};

export type AuditCsv = { csv: string; filename: string };

/**
 * One page of audit history: the caller's own events plus events in projects
 * they own or that are shared with their email.
 */
export async function listAuditEvents(
  db: Db,
  args: {
    userId: string;
    email: string | undefined;
    query: Record<string, unknown>;
  },
): Promise<ServiceResult<AuditPage>> {
  const parsed = parseQuery(args.query, PAGE_SIZE);
  if (!parsed.ok) return failure("validation", parsed.error);
  const q = parsed.query;
  const { data, error, count } = await queryEvents(
    db,
    args.userId,
    args.email,
    q,
  );
  if (error) return internalFailure(error);
  return ok({
    events: data ?? [],
    total: count ?? 0,
    page: q.page,
    pageSize: PAGE_SIZE,
  });
}

/**
 * Synchronous CSV export of the same visibility-scoped history. buildAuditCsv
 * throws so the async "audit-csv" job can retry; here the throw is converted
 * into an internal failure, unwrapping `cause` so the log still carries the
 * PostgrestError's code/details/hint rather than only its message.
 */
export async function exportAuditCsv(
  db: Db,
  args: {
    userId: string;
    email: string | undefined;
    query: Record<string, unknown>;
  },
): Promise<ServiceResult<AuditCsv>> {
  const parsed = parseQuery(args.query, AUDIT_EXPORT_LIMIT);
  if (!parsed.ok) return failure("validation", parsed.error);
  try {
    const csv = await buildAuditCsv(db, args.userId, args.email, parsed.query);
    return ok({ csv, filename: AUDIT_CSV_FILENAME });
  } catch (err) {
    return internalFailure(err instanceof Error && err.cause ? err.cause : err);
  }
}
