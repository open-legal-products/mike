// HTTP layer for the contracts module (Janus contract review inside Mike):
//   GET    /contracts               team-wide review list for the dashboard
//   GET    /contracts/me            caller identity + admin flag (client-side gating)
//   POST   /contracts/upload        raw DOCX bytes → extracted text + HTML
//   POST   /contracts               create a review row and start the async AI review
//   GET    /contracts/:id/status    poll review processing state
//   DELETE /contracts/:id           admin only
//
// Handlers parse the request, call contracts.service, and map ServiceResults
// onto status codes. Never query the database here.
//
// The upload endpoint takes the file as a raw body (Content-Type
// application/octet-stream, filename in `?filename=` or `x-filename`) instead of
// multipart: the multipart helper left the kernel when uploads moved to the
// object-storage session protocol, and a 25MB in-memory DOCX needs no session.

import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  CONTRACT_UPLOAD_MAX_BYTES,
  createReview,
  deleteReview,
  extractContract,
  getCallerIdentity,
  getReviewStatus,
  listReviews,
  parseCreateReviewBody,
  runReview,
} from "./contracts.service";

export const contractsRouter = Router();
contractsRouter.use(requireAuth);

contractsRouter.get("/", asyncRoute(async (_req, res) => {
  const result = await listReviews(createServerSupabase());
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.get("/me", asyncRoute(async (_req, res) => {
  const result = await getCallerIdentity(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

function uploadFilename(req: express.Request): string {
  const fromQuery = typeof req.query.filename === "string" ? req.query.filename : "";
  const fromHeader = req.get("x-filename") ?? "";
  const raw = fromQuery || fromHeader;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

contractsRouter.post(
  "/upload",
  express.raw({ type: () => true, limit: CONTRACT_UPLOAD_MAX_BYTES }),
  asyncRoute(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await extractContract({ buffer, filename: uploadFilename(req) });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

contractsRouter.post("/", asyncRoute(async (req, res) => {
  const parsed = parseCreateReviewBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);

  const db = createServerSupabase();
  const created = await createReview(db, { userId: res.locals.userId as string, input: parsed.data });
  if (!created.ok) return void sendServiceFailure(res, created);

  // Detached: the AI review runs ~30-60s. runReview handles its own errors and
  // flips the row to "failed"; .catch is a backstop against a crashed promise.
  void runReview(db, created.data.id, parsed.data).catch((err) =>
    console.error(`[contracts] runReview crashed for ${created.data.id}:`, err),
  );

  res.status(201).json(created.data);
}));

contractsRouter.get("/:id/status", asyncRoute(async (req, res) => {
  const result = await getReviewStatus(createServerSupabase(), req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.delete("/:id", asyncRoute(async (req, res) => {
  const result = await deleteReview(createServerSupabase(), {
    userId: res.locals.userId as string,
    reviewId: req.params.id,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(204).send();
}));

contractsRouter.use(routerErrorHandler("[contracts]"));
