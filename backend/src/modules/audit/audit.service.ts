// Business logic + data-access for the audit module.
//
// Service layer behind audit.routes.ts. listAuditEvents takes an explicit
// Supabase client (`db`) plus request-derived primitives, parses the caller's
// filter, runs the visibility-scoped query, and RETURNS a `ServiceResult`.
// It never touches req/res.
//
// The query/CSV primitives themselves live in lib/auditExport because the
// async "audit-csv" export job reuses them; they are re-exported by name here
// so the module's facade is the one door into the audit surface.

import type { Db } from "../../lib/supabase";
import { parseQuery, queryEvents } from "../../lib/auditExport";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

export {
  csvCell,
  parseQuery,
  queryEvents,
} from "../../lib/auditExport";

export const PAGE_SIZE = 50;

export type AuditPage = {
  events: unknown[];
  total: number;
  page: number;
  pageSize: number;
};

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

export { handleChatTurnAudit } from "./audit.jobs";
