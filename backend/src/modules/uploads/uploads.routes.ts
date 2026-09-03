// HTTP layer for the uploads module.
//
// Handlers here own only what is genuinely HTTP: the two rate limiters, the
// uuid param guards, the zod body parse, the storage-configured gate, and the
// mapping of a service result onto a status code and JSON body. Every query,
// storage call, and state transition lives behind uploads.service.ts.
//
// File bytes never reach Express: the client PUTs them straight to object
// storage against the signed URLs these endpoints hand out, so the JSON body
// limit in app.ts stays small no matter how large the upload is.

import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { sendInternalError } from "../../lib/httpError";
import { uploadSessionRateLimitConfiguration } from "../../lib/runtimeConfig";
import { storageEnabled } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
// Sibling topic files are imported directly, as in every module; outside the
// module, uploads.service.ts is the only door.
import { validateDestinationAccess } from "./uploads.access";
import {
  parseUploadSessionRequest,
  UploadSessionValidationError,
  type ParsedUploadSessionRequest,
} from "./uploads.manifest";
import {
  cancelUploadSession,
  completeUploadSessionFile,
  createUploadSession,
  getUploadSession,
  refreshUploadUrls,
} from "./uploads.sessions";
import type { UploadFailure } from "./uploads.shared";

export const uploadSessionsRouter = Router();

const uploadRateLimits = uploadSessionRateLimitConfiguration();

const uploadSessionMutationLimiter = rateLimit({
  windowMs: uploadRateLimits.mutationWindowMinutes * 60 * 1000,
  max: uploadRateLimits.mutationMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_control_rate_limit",
    detail: "Too many upload requests. Please try again later.",
  },
});

// Key by the authenticated user, not the caller-supplied session id, so random
// path segments cannot create unlimited limiter buckets. The client backs off
// status polling, while this independent ceiling protects the API from abuse.
const uploadSessionPollingLimiter = rateLimit({
  windowMs: uploadRateLimits.pollingWindowMinutes * 60 * 1000,
  max: uploadRateLimits.pollingMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_poll_rate_limit",
    detail: "Upload status was checked too often. Please try again shortly.",
  },
});

const sessionIdSchema = z.string().uuid();
const fileCompletionRequestSchema = z
  .object({ failed: z.boolean().default(false) })
  .strict();

uploadSessionsRouter.param("sessionId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload session not found" });
  }
  next();
});

uploadSessionsRouter.param("fileId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload file not found" });
  }
  next();
});

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

/** The one place a service failure becomes a response. */
function sendUploadFailure(res: Response, failure: UploadFailure): void {
  if (failure.kind === "internal") {
    sendInternalError(res, failure.error, failure.status);
    return;
  }
  res.status(failure.status).json(failure.body);
}

// POST /upload-sessions
uploadSessionsRouter.post(
  "/",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const sessionId = randomUUID();
    let manifest: ParsedUploadSessionRequest;
    try {
      manifest = parseUploadSessionRequest(req.body, userId, sessionId);
    } catch (error) {
      if (error instanceof UploadSessionValidationError) {
        return void res
          .status(error.status)
          .json({ code: error.code, detail: error.message });
      }
      throw error;
    }

    const db = createServerSupabase();
    const access = await validateDestinationAccess(
      manifest,
      userId,
      userEmail,
      db,
    );
    if (!access.ok) return void sendUploadFailure(res, access);

    const created = await createUploadSession(db, {
      sessionId,
      userId,
      manifest,
      hourlySessionLimit: uploadRateLimits.sessionCreationMaxPerHour,
    });
    if (!created.ok) return void sendUploadFailure(res, created);
    res.status(201).json(created.data);
  }),
);

// GET /upload-sessions/:sessionId
uploadSessionsRouter.get(
  "/:sessionId",
  requireAuth,
  uploadSessionPollingLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getUploadSession(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.json(result.data);
  }),
);

// POST /upload-sessions/:sessionId/urls
uploadSessionsRouter.post(
  "/:sessionId/urls",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await refreshUploadUrls(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.json(result.data);
  }),
);

// POST /upload-sessions/:sessionId/files/:fileId/complete
uploadSessionsRouter.post(
  "/:sessionId/files/:fileId/complete",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const parsed = fileCompletionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return void res
        .status(400)
        .json({ detail: "Invalid completion request" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await completeUploadSessionFile(db, {
      sessionId: req.params.sessionId,
      fileId: req.params.fileId,
      userId,
      failed: parsed.data.failed,
    });
    if (!result.ok) return void sendUploadFailure(res, result);
    res.status(result.data.status).json(result.data.body);
  }),
);

// DELETE /upload-sessions/:sessionId
uploadSessionsRouter.delete(
  "/:sessionId",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await cancelUploadSession(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.status(204).end();
  }),
);
