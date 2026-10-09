// HTTP layer for the audit module — GET /audit (JSON, paginated). The CSV
// export runs as the durable "audit-csv" job behind POST /user/exports.
//
// Handlers read the caller off res.locals, pass the raw query string through
// to audit.service, and map its `ServiceResult` onto a status code, headers,
// and body. Visibility (own events plus events in accessible projects) is
// enforced in the service.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { listAuditEvents } from "./audit.service";

export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get("/", asyncRoute(async (req, res) => {
  const result = await listAuditEvents(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
    query: req.query as Record<string, unknown>,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

auditRouter.use(routerErrorHandler("[audit]"));
