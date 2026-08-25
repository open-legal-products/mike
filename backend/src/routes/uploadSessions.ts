import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { ensureDocAccess, checkProjectAccess } from "../lib/access";
import { sendInternalError } from "../lib/httpError";
import {
  copyFile,
  deleteFile,
  getSignedUploadUrl,
  headFile,
  StorageOperationError,
  storageEnabled,
} from "../lib/storage";
import { createServerSupabase } from "../lib/supabase";
import {
  parseUploadSessionRequest,
  uploadSessionExpiresAt,
  UploadSessionValidationError,
  UPLOAD_URL_TTL_SECONDS,
  UPLOAD_VERIFICATION_LEASE_SECONDS,
  type ParsedUploadSessionRequest,
  type UploadSessionFile,
} from "../lib/uploadSessions";
import { requireAuth } from "../middleware/auth";

export const uploadSessionsRouter = Router();

const uploadSessionMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_control_rate_limit",
    detail: "Too many upload requests. Please try again later.",
  },
});

// Two active sessions polling every 750ms use about 2,400 requests per
// 15-minute window. Key by the authenticated user, not the caller-supplied
// session id, so random path segments cannot create unlimited limiter buckets.
const uploadSessionPollingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3_000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_poll_rate_limit",
    detail: "Upload status was checked too often. Please try again shortly.",
  },
});

const sessionIdSchema = z.string().uuid();
const completionRequestSchema = z
  .object({
    failed_client_ids: z
      .array(z.string().trim().min(1).max(128))
      .max(50)
      .default([]),
  })
  .strict();

uploadSessionsRouter.param("sessionId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload session not found" });
  }
  next();
});

type Db = ReturnType<typeof createServerSupabase>;
type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

type UploadSessionRow = {
  id: string;
  user_id: string;
  purpose: string;
  destination: Record<string, unknown>;
  expected_file_count: number;
  expected_total_bytes: number;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type UploadSessionFileRow = UploadSessionFile & {
  session_id: string;
  observed_size_bytes: number | null;
  etag: string | null;
  status: string;
  error_code: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function publicFile(file: UploadSessionFileRow | UploadSessionFile) {
  return {
    id: file.id,
    resource_id: file.resource_id,
    client_id: file.client_id,
    filename: file.filename,
    target_folder_id: file.target_folder_id,
    file_type: file.file_type,
    content_type: file.content_type,
    expected_size_bytes: file.expected_size_bytes,
    observed_size_bytes:
      "observed_size_bytes" in file ? file.observed_size_bytes : null,
    status: "status" in file ? file.status : "pending_upload",
    error_code: "error_code" in file ? file.error_code : null,
    result: "result" in file ? file.result : null,
  };
}

export async function validateDestinationAccess(
  manifest: ParsedUploadSessionRequest,
  userId: string,
  userEmail: string | undefined,
  db: Db,
  res: Response,
): Promise<boolean> {
  const destination = manifest.destination as Record<string, unknown>;

  if (manifest.purpose === "document_create") {
    if (destination.scope === "standalone") return true;
    if (destination.scope === "project") {
      const projectId = destination.project_id as string;
      const access = await checkProjectAccess(projectId, userId, userEmail, db);
      if (!access.ok) {
        res.status(404).json({ detail: "Project not found" });
        return false;
      }
      const folderIds = Array.from(
        new Set(
          [
            destination.folder_id as string | null | undefined,
            ...manifest.files.map((file) => file.target_folder_id),
          ].filter((value): value is string => !!value),
        ),
      );
      if (folderIds.length) {
        const { data, error } = await db
          .from("project_subfolders")
          .select("id")
          .eq("project_id", projectId)
          .in("id", folderIds);
        if (error) {
          sendInternalError(res, error);
          return false;
        }
        if ((data ?? []).length !== folderIds.length) {
          res.status(404).json({ detail: "Folder not found" });
          return false;
        }
      }
      return true;
    }

    const folderIds = Array.from(
      new Set(
        [
          destination.folder_id as string | null | undefined,
          ...manifest.files.map((file) => file.target_folder_id),
        ].filter((value): value is string => !!value),
      ),
    );
    if (!folderIds.length) return true;
    const { data, error } = await db
      .from("library_folders")
      .select("id")
      .eq("user_id", userId)
      .eq("library_kind", destination.library_kind as string)
      .in("id", folderIds);
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if ((data ?? []).length !== folderIds.length) {
      res.status(404).json({ detail: "Folder not found" });
      return false;
    }
    return true;
  }

  if (
    manifest.purpose === "document_version_create" ||
    manifest.purpose === "document_version_replace"
  ) {
    const documentId = destination.document_id as string;
    const { data: document, error } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .maybeSingle();
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if (!document) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    const access = await ensureDocAccess(document, userId, userEmail, db);
    if (
      !access.ok ||
      (manifest.purpose === "document_version_replace" && !access.isOwner)
    ) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    if (manifest.purpose === "document_version_create") return true;

    const { data: version, error: versionError } = await db
      .from("document_versions")
      .select("id, file_type, deleted_at")
      .eq("id", destination.version_id as string)
      .eq("document_id", documentId)
      .maybeSingle();
    if (versionError) {
      sendInternalError(res, versionError);
      return false;
    }
    if (!version || version.deleted_at) {
      res.status(404).json({ detail: "Version not found" });
      return false;
    }
    if (
      version.file_type &&
      version.file_type !== manifest.files[0].file_type
    ) {
      res.status(400).json({
        detail: `Uploaded file type (${manifest.files[0].file_type}) does not match version type (${version.file_type}).`,
      });
      return false;
    }
    return true;
  }

  const workflowId = destination.workflow_id as string;
  const { data: workflow, error } = await db
    .from("workflows")
    .select("id, user_id, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (error) {
    sendInternalError(res, error);
    return false;
  }
  if (!workflow) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }

  let canEdit = workflow.user_id === userId;
  if (!canEdit && userEmail) {
    const { data: share, error: shareError } = await db
      .from("workflow_shares")
      .select("allow_edit")
      .eq("workflow_id", workflowId)
      .eq("shared_with_email", userEmail.trim().toLowerCase())
      .maybeSingle();
    if (shareError) {
      sendInternalError(res, shareError);
      return false;
    }
    canEdit = share?.allow_edit === true;
  }
  if (!canEdit) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }
  if (workflow.type === "tabular") {
    res.status(400).json({
      detail: "Reference files are only supported for assistant workflows",
    });
    return false;
  }

  if (manifest.purpose === "workflow_reference_replace") {
    const { data: reference, error: referenceError } = await db
      .from("workflow_reference_documents")
      .select("id")
      .eq("id", destination.reference_id as string)
      .eq("workflow_id", workflowId)
      .maybeSingle();
    if (referenceError) {
      sendInternalError(res, referenceError);
      return false;
    }
    if (!reference) {
      res.status(404).json({ detail: "Reference file not found" });
      return false;
    }
  }
  return true;
}

async function loadOwnedSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadSessionRow | null> {
  const { data, error } = await db
    .from("upload_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UploadSessionRow | null) ?? null;
}

async function loadSessionFiles(
  db: Db,
  sessionId: string,
): Promise<UploadSessionFileRow[]> {
  const { data, error } = await db
    .from("upload_session_files")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as UploadSessionFileRow[];
}

function signedUrlTtl(expiresAt: string): number {
  const remainingSeconds = Math.floor(
    (new Date(expiresAt).getTime() - Date.now()) / 1000,
  );
  return Math.max(1, Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds));
}

async function signPendingFiles(
  files: Array<UploadSessionFileRow | UploadSessionFile>,
  expiresAt: string,
) {
  const ttl = signedUrlTtl(expiresAt);
  return await Promise.all(
    files.map(async (file) => {
      const url = await getSignedUploadUrl(
        file.staging_storage_path,
        file.content_type,
        ttl,
      );
      if (!url) throw new Error("Failed to create signed upload URL");
      return {
        ...publicFile(file),
        upload: {
          method: "PUT" as const,
          url,
          headers: { "Content-Type": file.content_type },
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      };
    }),
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, runWorker),
  );
  return results;
}

async function verifyAndSealSessionFiles(
  db: Db,
  session: UploadSessionRow,
  files: UploadSessionFileRow[],
): Promise<boolean[]> {
  return await mapWithConcurrency(files, 5, async (file) => {
    const sealed = await headFile(file.sealed_storage_path);
    if (sealed?.size === file.expected_size_bytes) {
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "uploaded",
          observed_size_bytes: sealed.size,
          etag: sealed.etag,
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id);
      if (error) throw error;
      return true;
    }

    const staged = await headFile(file.staging_storage_path);
    if (!staged) return false;
    if (
      staged.size !== file.expected_size_bytes ||
      (staged.contentType && staged.contentType !== file.content_type)
    ) {
      const errorCode =
        staged.size !== file.expected_size_bytes
          ? "size_mismatch"
          : "content_type_mismatch";
      await deleteFile(file.staging_storage_path).catch(() => {});
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "error",
          observed_size_bytes: staged.size,
          etag: staged.etag,
          error_code: errorCode,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id);
      if (error) throw error;
      return false;
    }

    await copyFile(file.staging_storage_path, file.sealed_storage_path);
    const copied = await headFile(file.sealed_storage_path);
    if (!copied || copied.size !== file.expected_size_bytes) {
      throw new Error("Failed to verify sealed upload object");
    }
    await deleteFile(file.staging_storage_path);
    const { error } = await db
      .from("upload_session_files")
      .update({
        status: "uploaded",
        observed_size_bytes: copied.size,
        etag: copied.etag,
        error_code: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", file.id)
      .eq("session_id", session.id);
    if (error) throw error;
    return true;
  });
}

async function releaseVerificationClaim(db: Db, sessionId: string) {
  await db
    .from("upload_sessions")
    .update({ status: "pending_upload", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "verifying");
}

function verificationLeaseCutoff(): string {
  return new Date(
    Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000,
  ).toISOString();
}

async function recoverStaleVerification(
  db: Db,
  session: UploadSessionRow,
  userId: string,
): Promise<UploadSessionRow> {
  if (
    session.status !== "verifying" ||
    new Date(session.updated_at).getTime() >
      Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000
  ) {
    return session;
  }
  const { data, error } = await db
    .from("upload_sessions")
    .update({ status: "pending_upload", updated_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("user_id", userId)
    .eq("status", "verifying")
    .lte("updated_at", verificationLeaseCutoff())
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UploadSessionRow | null) ?? session;
}

async function markFailedTransfers(
  db: Db,
  sessionId: string,
  files: UploadSessionFileRow[],
  failedClientIds: Set<string>,
): Promise<void> {
  if (failedClientIds.size === 0) return;
  const failedFiles = files.filter((file) => failedClientIds.has(file.client_id));
  await mapWithConcurrency(failedFiles, 5, async (file) => {
    await Promise.all([
      deleteFile(file.staging_storage_path).catch(() => {}),
      deleteFile(file.sealed_storage_path).catch(() => {}),
    ]);
  });
  const { error } = await db
    .from("upload_session_files")
    .update({
      status: "error",
      error_code: "direct_upload_failed",
      updated_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId)
    .in("client_id", [...failedClientIds]);
  if (error) throw error;
}

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
    if (
      !(await validateDestinationAccess(manifest, userId, userEmail, db, res))
    ) {
      return;
    }

    const expiresAt = uploadSessionExpiresAt();
    const { error } = await db.rpc("create_upload_session", {
      target_session_id: sessionId,
      target_user_id: userId,
      target_purpose: manifest.purpose,
      target_destination: manifest.destination,
      target_expires_at: expiresAt,
      target_files: manifest.files,
    });
    if (error) {
      if (error.message?.includes("upload_session_rate_limit_exceeded")) {
        return void res.status(429).json({
          code: "upload_session_rate_limit_exceeded",
          detail: "Too many upload sessions. Please try again later.",
        });
      }
      if (error.message?.includes("active_upload_session_limit_exceeded")) {
        return void res.status(429).json({
          code: "active_upload_session_limit_exceeded",
          detail:
            "Finish or cancel an existing upload before starting another.",
        });
      }
      if (error.message?.includes("upload_target_busy")) {
        return void res.status(409).json({
          code: "upload_target_busy",
          detail: "Another upload is already updating this item.",
        });
      }
      if (
        error.message?.includes("upload_file_count_limit_exceeded") ||
        error.message?.includes("upload_total_size_limit_exceeded") ||
        error.message?.includes("invalid_upload_manifest")
      ) {
        return void res.status(400).json({ detail: "Invalid upload manifest" });
      }
      return void sendInternalError(res, error);
    }

    try {
      const files = await signPendingFiles(manifest.files, expiresAt);
      res.status(201).json({
        session: {
          id: sessionId,
          purpose: manifest.purpose,
          destination: manifest.destination,
          expected_file_count: manifest.files.length,
          expected_total_bytes: manifest.expected_total_bytes,
          status: "pending_upload",
          expires_at: expiresAt,
        },
        files,
      });
    } catch (error) {
      await db
        .from("upload_sessions")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", userId);
      return void sendInternalError(res, error, 503);
    }
  }),
);

uploadSessionsRouter.get(
  "/:sessionId",
  requireAuth,
  uploadSessionPollingLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const files = await loadSessionFiles(db, session.id);
    res.json({ session, files: files.map(publicFile) });
  }),
);

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
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    if (session.status !== "pending_upload") {
      return void res.status(409).json({
        detail: "Upload URLs can only be refreshed for a pending session",
      });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await db
        .from("upload_sessions")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", session.id)
        .eq("status", "pending_upload");
      return void res.status(410).json({ detail: "Upload session expired" });
    }

    const files = await loadSessionFiles(db, session.id);
    const pendingFiles = files.filter((file) => file.status !== "uploaded");
    if (pendingFiles.length) {
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "pending_upload",
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("session_id", session.id)
        .neq("status", "uploaded");
      if (error) return void sendInternalError(res, error);
    }
    res.json({
      files: await signPendingFiles(pendingFiles, session.expires_at),
    });
  }),
);

uploadSessionsRouter.post(
  "/:sessionId/complete",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const parsedCompletion = completionRequestSchema.safeParse(req.body ?? {});
    if (!parsedCompletion.success) {
      return void res.status(400).json({ detail: "Invalid completion request" });
    }
    let session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    session = await recoverStaleVerification(db, session, userId);
    if (
      ["uploaded", "processing", "completed", "error"].includes(
        session.status,
      )
    ) {
      const files = await loadSessionFiles(db, session.id);
      const { data: job } = await db
        .from("upload_processing_jobs")
        .select("id, status")
        .eq("session_id", session.id)
        .maybeSingle();
      return void res.json({
        session,
        processing_job: job ?? null,
        files: files.map(publicFile),
      });
    }
    if (session.status !== "pending_upload") {
      return void res
        .status(409)
        .json({ detail: "Upload session is not pending" });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await db
        .from("upload_sessions")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", session.id)
        .eq("status", "pending_upload");
      return void res.status(410).json({ detail: "Upload session expired" });
    }

    const files = await loadSessionFiles(db, session.id);
    const failedClientIds = new Set(parsedCompletion.data.failed_client_ids);
    if (
      failedClientIds.size !== parsedCompletion.data.failed_client_ids.length ||
      [...failedClientIds].some(
        (clientId) => !files.some((file) => file.client_id === clientId),
      )
    ) {
      return void res.status(400).json({ detail: "Invalid failed file list" });
    }

    const { data: claimed, error: claimError } = await db
      .from("upload_sessions")
      .update({ status: "verifying", updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("user_id", userId)
      .eq("status", "pending_upload")
      .select("id")
      .maybeSingle();
    if (claimError) return void sendInternalError(res, claimError);
    if (!claimed) {
      return void res.status(409).json({
        code: "upload_completion_in_progress",
        detail: "This upload session is already being completed.",
      });
    }

    try {
      await markFailedTransfers(db, session.id, files, failedClientIds);
      const filesToVerify = files.filter(
        (file) => !failedClientIds.has(file.client_id),
      );
      if (filesToVerify.length === 0) {
        const now = new Date().toISOString();
        const { error } = await db
          .from("upload_sessions")
          .update({
            status: "error",
            error_code: "all_uploads_failed",
            completed_at: now,
            cleaned_at: now,
            updated_at: now,
          })
          .eq("id", session.id)
          .eq("user_id", userId)
          .eq("status", "verifying");
        if (error) throw error;
        const updated = await loadOwnedSession(db, session.id, userId);
        const currentFiles = await loadSessionFiles(db, session.id);
        return void res.json({
          session: updated,
          processing_job: null,
          files: currentFiles.map(publicFile),
        });
      }

      await verifyAndSealSessionFiles(db, session, filesToVerify);
      const currentFiles = await loadSessionFiles(db, session.id);
      const unresolvedFiles = currentFiles.filter(
        (file) => file.status === "pending_upload",
      );

      if (unresolvedFiles.length > 0) {
        await releaseVerificationClaim(db, session.id);
        return void res.status(409).json({
          code: "upload_incomplete",
          detail: "One or more files are missing.",
          files: currentFiles.map(publicFile),
        });
      }

      const uploadedFiles = currentFiles.filter(
        (file) => file.status === "uploaded",
      );
      if (uploadedFiles.length === 0) {
        const uploadedTooManyBytes = currentFiles.some(
          (file) =>
            file.error_code === "size_mismatch" &&
            (file.observed_size_bytes ?? 0) > file.expected_size_bytes,
        );
        const contentTypeMismatch = currentFiles.some(
          (file) => file.error_code === "content_type_mismatch",
        );
        const now = new Date().toISOString();
        const { error } = await db
          .from("upload_sessions")
          .update({
            status: "error",
            error_code: uploadedTooManyBytes
              ? "uploaded_size_exceeded_reservation"
              : contentTypeMismatch
                ? "uploaded_content_type_mismatch"
                : "all_uploads_failed",
            completed_at: now,
            updated_at: now,
          })
          .eq("id", session.id)
          .eq("status", "verifying");
        if (error) throw error;
        return void res
          .status(uploadedTooManyBytes ? 413 : contentTypeMismatch ? 415 : 409)
          .json({
            code: uploadedTooManyBytes
              ? "uploaded_size_exceeded_reservation"
              : contentTypeMismatch
                ? "uploaded_content_type_mismatch"
                : "all_uploads_failed",
            detail: uploadedTooManyBytes
              ? "An uploaded file is larger than its reserved size."
              : contentTypeMismatch
                ? "An uploaded file does not match its reserved content type."
                : "No files could be uploaded.",
            files: currentFiles.map(publicFile),
          });
      }

      const { data: jobId, error } = await db.rpc(
        "queue_upload_session_processing",
        {
          target_session_id: session.id,
          target_user_id: userId,
        },
      );
      if (error) {
        if (error.message?.includes("upload_session_incomplete")) {
          await releaseVerificationClaim(db, session.id);
          return void res.status(409).json({
            code: "upload_incomplete",
            detail: "One or more uploaded files could not be verified.",
          });
        }
        throw error;
      }
      const updated = await loadOwnedSession(db, session.id, userId);
      if (!updated) {
        throw new Error("Queued upload session could not be reloaded");
      }
      res.json({
        session: updated,
        processing_job: { id: jobId, status: "queued" },
        files: currentFiles.map(publicFile),
      });
    } catch (error) {
      await releaseVerificationClaim(db, session.id);
      if (error instanceof StorageOperationError) {
        return void sendInternalError(res, error, 503);
      }
      throw error;
    }
  }),
);

uploadSessionsRouter.delete(
  "/:sessionId",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const staleVerification =
      session.status === "verifying" &&
      new Date(session.updated_at).getTime() <=
        Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000;
    if (session.status !== "pending_upload" && !staleVerification) {
      return void res
        .status(409)
        .json({ detail: "Upload session cannot be cancelled" });
    }
    const now = new Date().toISOString();
    let cancellationQuery = db
      .from("upload_sessions")
      .update({ status: "cancelled", cancelled_at: now, updated_at: now })
      .eq("id", session.id)
      .eq("user_id", userId)
      .eq("status", staleVerification ? "verifying" : "pending_upload");
    if (staleVerification) {
      cancellationQuery = cancellationQuery.lte(
        "updated_at",
        verificationLeaseCutoff(),
      );
    }
    const { data: cancelled, error } = await cancellationQuery
      .select("id")
      .maybeSingle();
    if (error) return void sendInternalError(res, error);
    if (!cancelled) {
      return void res.status(409).json({
        detail:
          "Upload session is already being completed and cannot be cancelled",
      });
    }

    const files = await loadSessionFiles(db, session.id);
    await mapWithConcurrency(files, 5, async (file) => {
      await Promise.all([
        deleteFile(file.staging_storage_path).catch(() => {}),
        deleteFile(file.sealed_storage_path).catch(() => {}),
      ]);
    });
    const { error: cleanupError } = await db
      .from("upload_sessions")
      .update({ cleaned_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "cancelled");
    if (cleanupError) return void sendInternalError(res, cleanupError);
    res.status(204).end();
  }),
);
