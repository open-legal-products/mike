// HTTP layer for the audit module — GET /audit (JSON, paginated) +
// GET /audit/export (CSV).
//
// Handlers read the caller off res.locals, pass the raw query string through
// to audit.service, and map its `ServiceResult` onto a status code, headers,
// and body. Visibility (own events plus events in accessible projects) is
// enforced in the service.

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { exportAuditCsv, listAuditEvents } from "./audit.service";

export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get("/", async (req, res) => {
  const result = await listAuditEvents(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
    query: req.query as Record<string, unknown>,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
});

// Synchronous CSV export. Still here for curl users and older clients; the
// frontend goes through the durable "audit-csv" export job instead. Both
// emit the same bytes because both render through buildAuditCsv.
auditRouter.get("/export", requireMfaIfEnrolled, async (req, res) => {
  const result = await exportAuditCsv(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
    query: req.query as Record<string, unknown>,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${result.data.filename}"`,
  );
  res.send(result.data.csv);
});
