// HTTP layer for the quick-actions module.
//
// Route handlers read the caller off res.locals, hand the raw payload to the
// quickActions.service functions, and map their `ServiceResult`s onto status
// codes and JSON. The trailing routerErrorHandler is the containment for the
// hydration queries that throw: it attributes the failure to this router in the
// log and hands the response to app.ts's boundary, which answers the same
// opaque internal_error body every other router answers with.

import { resolveWorkspaceFilter, sendWorkspaceFailure } from "../../lib/workspace";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  createQuickAction,
  deleteQuickAction,
  listQuickActions,
  updateQuickAction,
} from "./quickActions.service";

export const quickActionsRouter = Router();

quickActionsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const workspace = await resolveWorkspaceFilter(db, res.locals.userId as string, req.query.workspace);
    if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
    const result = await listQuickActions(db, {
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      surface: req.query.surface,
      workspace: workspace.workspace,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

quickActionsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await createQuickAction(createServerSupabase(), {
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data);
  }),
);

// A malformed id reached Postgres as `uuid = 'not-a-uuid'` (22P02) and
// surfaced as a 500; an id that cannot exist is simply not found.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

quickActionsRouter.patch(
  "/:quickActionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.quickActionId))
      return void res.status(404).json({ detail: "Quick action not found" });
    const result = await updateQuickAction(createServerSupabase(), {
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      quickActionId: req.params.quickActionId,
      body: req.body,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

quickActionsRouter.delete(
  "/:quickActionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.quickActionId))
      return void res.status(404).json({ detail: "Quick action not found" });
    const result = await deleteQuickAction(createServerSupabase(), {
      userId: res.locals.userId as string,
      quickActionId: req.params.quickActionId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

quickActionsRouter.use(routerErrorHandler("[quick-actions]"));
