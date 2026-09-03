// HTTP layer for the quick-actions module.
//
// Route handlers read the caller off res.locals, hand the raw payload to the
// quickActions.service functions, and map their `ServiceResult`s onto status
// codes and JSON. The trailing error middleware is the containment for the
// hydration queries that throw: it keeps rendering the same generic message
// this router has always sent instead of leaking a database error.

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  createQuickAction,
  deleteQuickAction,
  listQuickActions,
  updateQuickAction,
} from "./quickActions.service";

export const quickActionsRouter = Router();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

quickActionsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await listQuickActions(createServerSupabase(), {
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      surface: req.query.surface,
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

quickActionsRouter.patch(
  "/:quickActionId",
  requireAuth,
  asyncRoute(async (req, res) => {
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
    const result = await deleteQuickAction(createServerSupabase(), {
      userId: res.locals.userId as string,
      quickActionId: req.params.quickActionId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(204).send();
  }),
);

quickActionsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[quick-actions] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process quick action request" });
  },
);
