import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { getProjectEmailReceipt, importProjectEmail, latestProjectEmail, previewProjectEmail } from "./project-email.service";

export const projectEmailRouter = Router();
projectEmailRouter.use(requireAuth);
projectEmailRouter.use(rateLimit({ windowMs: 60_000, max: 12, standardHeaders: true, legacyHeaders: false, keyGenerator: (_req, res) => String(res.locals.userId), message: { detail: "Too many email intake requests. Please try again shortly." } }));
const uuid = z.string().uuid();
const previewBody = z.object({ query: z.string().trim().min(1).max(2000), folderId: uuid.nullable().optional(), pageToken: z.string().max(2048).optional() }).strict();
const confirmation = z.object({ selectedIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/)).min(1).max(5), shareWithProject: z.literal(true) }).strict();
projectEmailRouter.param("projectId", (_req, res, next, value) => { if (!uuid.safeParse(value).success) return void res.status(404).json({ detail: "Project not found." }); next(); });
projectEmailRouter.param("previewId", (_req, res, next, value) => { if (!uuid.safeParse(value).success) return void res.status(404).json({ detail: "Email preview not found." }); next(); });
projectEmailRouter.post("/:projectId/preview", asyncRoute(async (req, res) => {
  const body = previewBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ detail: "Enter a bounded Gmail query and valid destination." });
  const result = await previewProjectEmail(createServerSupabase(), { userId: res.locals.userId, userEmail: res.locals.userEmail, projectId: String(req.params.projectId) }, body.data);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));
projectEmailRouter.post("/:projectId/:previewId/import", asyncRoute(async (req, res) => {
  const body = confirmation.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ detail: "Confirm the selected messages and sharing with this project." });
  const result = await importProjectEmail(createServerSupabase(), { userId: res.locals.userId, userEmail: res.locals.userEmail, projectId: String(req.params.projectId) }, String(req.params.previewId), body.data.selectedIds);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));
projectEmailRouter.get("/:projectId/:previewId/receipt", asyncRoute(async (req, res) => {
  const result = await getProjectEmailReceipt(createServerSupabase(), { userId: res.locals.userId, userEmail: res.locals.userEmail, projectId: String(req.params.projectId) }, String(req.params.previewId));
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));
projectEmailRouter.get("/:projectId/latest", asyncRoute(async (req, res) => {
  const result = await latestProjectEmail(createServerSupabase(), { userId: res.locals.userId, userEmail: res.locals.userEmail, projectId: String(req.params.projectId) });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));
projectEmailRouter.use(routerErrorHandler("[project-email]"));
