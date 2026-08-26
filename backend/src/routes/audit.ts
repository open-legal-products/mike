// Audit history — GET /audit (JSON, paginated) + GET /audit/export (CSV).
// Visibility: the caller's own events, plus events in projects they own or
// that are shared with their email.

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import {
  AUDIT_CSV_FILENAME,
  AUDIT_EXPORT_LIMIT,
  buildAuditCsv,
  parseQuery,
  queryEvents,
} from "../lib/auditExport";

// The query/CSV helpers moved to lib/auditExport so the async "audit-csv"
// export job can reuse them; re-exported here for existing importers.
export {
  buildAuditCsv,
  csvCell,
  escapeLikePattern,
  parseQuery,
  queryEvents,
} from "../lib/auditExport";
export type { AuditQuery, ParseQueryResult } from "../lib/auditExport";

export const auditRouter = Router();
auditRouter.use(requireAuth);

const PAGE_SIZE = 50;

// asyncRoute: an `async` handler that rejects is invisible to Express 4, so a
// throw from queryEvents (a network blip against PostgREST, say) would hang the
// request instead of answering. Forwarding to next() lets app.ts answer 500.
auditRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const email = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const parsed = parseQuery(req.query as Record<string, unknown>, PAGE_SIZE);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
    const q = parsed.query;
    const { data, error, count } = await queryEvents(db, userId, email, q);
    if (error) return void sendInternalError(res, error);
    res.json({
      events: data ?? [],
      total: count ?? 0,
      page: q.page,
      pageSize: PAGE_SIZE,
    });
  }),
);

// Synchronous CSV export. Still here for curl users and older clients; the
// frontend goes through the durable "audit-csv" export job instead. Both
// emit the same bytes because both render through buildAuditCsv.
auditRouter.get(
  "/export",
  requireMfaIfEnrolled,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const email = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const parsed = parseQuery(
      req.query as Record<string, unknown>,
      AUDIT_EXPORT_LIMIT,
    );
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
    let csv: string;
    try {
      csv = await buildAuditCsv(db, userId, email, parsed.query);
    } catch (err) {
      // buildAuditCsv throws so the async job retries; here the throw becomes
      // the same generic 500 this route has always sent, never the raw DB
      // message. Unwrap `cause` so the log still carries the PostgrestError's
      // code/details/hint rather than only its message.
      return void sendInternalError(
        res,
        err instanceof Error && err.cause ? err.cause : err,
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${AUDIT_CSV_FILENAME}"`,
    );
    res.send(csv);
  }),
);
