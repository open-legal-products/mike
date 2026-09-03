// The upload-session control plane: create a session, hand out signed URLs,
// seal what the browser uploaded, queue it for processing, and cancel.
//
// Every function here takes an explicit `db` and returns a value or an
// `UploadFailure`; uploads.routes.ts maps those onto status codes. File bytes
// never pass through Express — the browser PUTs them straight to object
// storage against a signed URL, and this file only ever moves objects between
// the staging and sealed prefixes and records what it observed.
//
// Two invariants are load-bearing:
//
//   * Sealing claims a file with a conditional `status = 'verifying'` update
//     and every subsequent write is conditioned on still holding that claim,
//     so a lost race reports "not sealed" instead of clobbering newer state.
//   * A verification lease is only reclaimed once it has aged past
//     UPLOAD_VERIFICATION_LEASE_SECONDS; a fresh one means another request is
//     still sealing that file.

import { mapWithConcurrency } from "../../lib/concurrency";
import {
  copyFile,
  deleteFile,
  getSignedUploadUrl,
  headFile,
  StorageOperationError,
} from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  uploadSessionExpiresAt,
  UPLOAD_URL_TTL_SECONDS,
  UPLOAD_VERIFICATION_LEASE_SECONDS,
  type ParsedUploadSessionRequest,
  type UploadSessionFile,
} from "./uploads.manifest";
import {
  failure,
  internalFailure,
  publicFile,
  type UploadResult,
  type UploadSessionFileRow,
  type UploadSessionRow,
} from "./uploads.shared";

// ---------------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

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
        file.expected_size_bytes,
        ttl,
      );
      if (!url) throw new Error("Failed to create signed upload URL");
      return {
        ...publicFile(file),
        upload: {
          method: "PUT" as const,
          url,
          // Content-Length is part of the signature but is deliberately absent
          // here: browsers set it from the body and refuse a manual override,
          // so a wrong-size body fails signature validation at the store.
          headers: { "Content-Type": file.content_type },
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

async function verifyAndSealSessionFiles(
  db: Db,
  session: UploadSessionRow,
  files: UploadSessionFileRow[],
): Promise<boolean[]> {
  // Every result write is conditioned on the file still being the 'verifying'
  // claim this call made. Losing that claim — a reset or a stolen lease — must
  // never overwrite the newer state, so it is reported as "not sealed" rather
  // than as an error.
  const writeSealResult = async (
    file: UploadSessionFileRow,
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    const { data, error } = await db
      .from("upload_session_files")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", file.id)
      .eq("session_id", session.id)
      .eq("status", "verifying")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return !!data;
  };

  return await mapWithConcurrency(files, 5, async (file) => {
    const sealed = await headFile(file.sealed_storage_path);
    if (sealed?.size === file.expected_size_bytes) {
      return await writeSealResult(file, {
        status: "uploaded",
        observed_size_bytes: sealed.size,
        etag: sealed.etag,
        error_code: null,
      });
    }

    const staged = await headFile(file.staging_storage_path);
    if (!staged) {
      await writeSealResult(file, { status: "pending_upload" });
      return false;
    }
    if (
      staged.size !== file.expected_size_bytes ||
      (staged.contentType && staged.contentType !== file.content_type)
    ) {
      const errorCode =
        staged.size !== file.expected_size_bytes
          ? "size_mismatch"
          : "content_type_mismatch";
      await deleteFile(file.staging_storage_path).catch(() => {});
      await writeSealResult(file, {
        status: "error",
        observed_size_bytes: staged.size,
        etag: staged.etag,
        error_code: errorCode,
      });
      return false;
    }

    await copyFile(file.staging_storage_path, file.sealed_storage_path);
    const copied = await headFile(file.sealed_storage_path);
    if (!copied || copied.size !== file.expected_size_bytes) {
      throw new Error("Failed to verify sealed upload object");
    }
    await deleteFile(file.staging_storage_path);
    return await writeSealResult(file, {
      status: "uploaded",
      observed_size_bytes: copied.size,
      etag: copied.etag,
      error_code: null,
    });
  });
}

function verificationLeaseCutoff(): string {
  return new Date(
    Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000,
  ).toISOString();
}

async function refreshSessionStatus(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("refresh_upload_session_status", {
    target_session_id: sessionId,
  });
  if (error) throw error;
}

/**
 * Slide the session deadline forward as files land. A large batch on a slow
 * uplink can outlive the initial 30-minute TTL; the RPC applies its own
 * absolute cap from session creation, so this cannot extend a session forever.
 * A failure here must never fail an upload that already succeeded.
 */
async function extendSessionExpiry(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("extend_upload_session_expiry", {
    target_session_id: sessionId,
  });
  if (error) {
    console.error("[upload-sessions] extending the session expiry failed", {
      sessionId,
      error,
    });
  }
}

async function queueFileProcessing(
  db: Db,
  sessionId: string,
  userId: string,
  fileId: string,
): Promise<string> {
  const { data, error } = await db.rpc("queue_upload_session_file_processing", {
    target_session_id: sessionId,
    target_user_id: userId,
    target_file_id: fileId,
  });
  if (error) throw error;
  if (typeof data !== "string" || !data) {
    throw new Error("Upload processing job was not created");
  }
  return data;
}

type FileCompletionResult = "resolved" | "incomplete" | "in_progress";

async function completeSessionFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadSessionFileRow,
  userId: string,
  failed: boolean,
): Promise<FileCompletionResult> {
  if (failed) {
    if (file.status === "verifying") {
      const { data: recovered, error } = await db
        .from("upload_session_files")
        .update({
          status: "pending_upload",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id)
        .eq("status", "verifying")
        .lte("updated_at", verificationLeaseCutoff())
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!recovered) return "in_progress";
    }
    if (file.status === "pending_upload" || file.status === "verifying") {
      await Promise.all([
        deleteFile(file.staging_storage_path).catch(() => {}),
        deleteFile(file.sealed_storage_path).catch(() => {}),
      ]);
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "error",
          error_code: "direct_upload_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id)
        .in("status", ["pending_upload", "verifying"]);
      if (error) throw error;
    }
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }

  if (file.status === "uploaded") {
    await queueFileProcessing(db, session.id, userId, file.id);
    await extendSessionExpiry(db, session.id);
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (["processing", "completed", "error"].includes(file.status)) {
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (file.status === "verifying") {
    const { data: recovered, error } = await db
      .from("upload_session_files")
      .update({
        status: "pending_upload",
        updated_at: new Date().toISOString(),
      })
      .eq("id", file.id)
      .eq("session_id", session.id)
      .eq("status", "verifying")
      .lte("updated_at", verificationLeaseCutoff())
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!recovered) return "in_progress";
  }

  const { data: claimed, error: claimError } = await db
    .from("upload_session_files")
    .update({ status: "verifying", updated_at: new Date().toISOString() })
    .eq("id", file.id)
    .eq("session_id", session.id)
    .eq("status", "pending_upload")
    .select("*")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return "in_progress";

  const [verified] = await verifyAndSealSessionFiles(db, session, [
    claimed as UploadSessionFileRow,
  ]);
  if (!verified) {
    await refreshSessionStatus(db, session.id);
    const currentFiles = await loadSessionFiles(db, session.id);
    const current = currentFiles.find((candidate) => candidate.id === file.id);
    return current?.status === "error" ? "resolved" : "incomplete";
  }
  await queueFileProcessing(db, session.id, userId, file.id);
  await extendSessionExpiry(db, session.id);
  await refreshSessionStatus(db, session.id);
  return "resolved";
}

// ---------------------------------------------------------------------------
// Service entry points
// ---------------------------------------------------------------------------

/**
 * Create the session row and return the signed URLs for its manifest. The
 * hourly ceiling is enforced inside the RPC (one transaction with the insert),
 * so the caller passes its configured limit rather than counting rows first.
 */
export async function createUploadSession(
  db: Db,
  args: {
    sessionId: string;
    userId: string;
    manifest: ParsedUploadSessionRequest;
    hourlySessionLimit: number;
  },
): Promise<UploadResult<Record<string, unknown>>> {
  const { sessionId, userId, manifest } = args;
  const expiresAt = uploadSessionExpiresAt();
  const { error } = await db.rpc("create_upload_session", {
    target_session_id: sessionId,
    target_user_id: userId,
    target_purpose: manifest.purpose,
    target_destination: manifest.destination,
    target_expires_at: expiresAt,
    target_files: manifest.files,
    target_hourly_session_limit: args.hourlySessionLimit,
  });
  if (error) {
    if (error.message?.includes("upload_session_rate_limit_exceeded")) {
      return failure(429, {
        code: "upload_session_rate_limit_exceeded",
        detail: "Too many upload sessions. Please try again later.",
      });
    }
    if (error.message?.includes("upload_target_busy")) {
      return failure(409, {
        code: "upload_target_busy",
        detail: "Another upload is already updating this item.",
      });
    }
    if (
      error.message?.includes("upload_file_count_limit_exceeded") ||
      error.message?.includes("upload_total_size_limit_exceeded") ||
      error.message?.includes("invalid_upload_manifest")
    ) {
      return failure(400, { detail: "Invalid upload manifest" });
    }
    return internalFailure(error);
  }

  try {
    const files = await signPendingFiles(manifest.files, expiresAt);
    return {
      ok: true,
      data: {
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
      },
    };
  } catch (error) {
    // The row exists but the client will never get a URL for it. Cancel it so
    // the target is not left "busy" for the next attempt.
    await db
      .from("upload_sessions")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("user_id", userId);
    return internalFailure(error, 503);
  }
}

/** The session plus its files, as the client polls them. */
export async function getUploadSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<Record<string, unknown>>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  const files = await loadSessionFiles(db, session.id);
  return { ok: true, data: { session, files: files.map(publicFile) } };
}

/**
 * Re-sign the files that have not landed yet. Signed URLs are shorter-lived
 * than the session, so a slow batch legitimately comes back for more.
 */
export async function refreshUploadUrls(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<Record<string, unknown>>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  if (session.status !== "pending_upload") {
    return failure(409, {
      detail: "Upload URLs can only be refreshed for a pending session",
    });
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await db
      .from("upload_sessions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "pending_upload");
    return failure(410, { detail: "Upload session expired" });
  }

  const files = await loadSessionFiles(db, session.id);
  const pendingFiles = files.filter((file) =>
    ["pending_upload", "verifying"].includes(file.status),
  );
  if (pendingFiles.some((file) => file.status === "pending_upload")) {
    const { error } = await db
      .from("upload_session_files")
      .update({
        status: "pending_upload",
        error_code: null,
        updated_at: new Date().toISOString(),
      })
      .eq("session_id", session.id)
      .eq("status", "pending_upload");
    if (error) return internalFailure(error);
  }
  if (pendingFiles.some((file) => file.status === "verifying")) {
    // Only reclaim a verification lease that has already expired. A fresh
    // one means another request is still sealing that file.
    const { error } = await db
      .from("upload_session_files")
      .update({
        status: "pending_upload",
        error_code: null,
        updated_at: new Date().toISOString(),
      })
      .eq("session_id", session.id)
      .eq("status", "verifying")
      .lte("updated_at", verificationLeaseCutoff());
    if (error) return internalFailure(error);
  }
  return {
    ok: true,
    data: { files: await signPendingFiles(pendingFiles, session.expires_at) },
  };
}

/**
 * The client reports one file as uploaded (or as failed). Seal it, queue its
 * processing job, and answer with the session's current state. `status` is the
 * HTTP status the route should use: 202 while another request still holds the
 * verification claim, 200 once this file is resolved.
 */
export async function completeUploadSessionFile(
  db: Db,
  args: {
    sessionId: string;
    fileId: string;
    userId: string;
    failed: boolean;
  },
): Promise<UploadResult<{ status: number; body: Record<string, unknown> }>> {
  const { sessionId, fileId, userId, failed } = args;
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  if (["cancelled", "expired"].includes(session.status)) {
    return failure(409, { detail: "Upload session is not active" });
  }
  if (
    session.status === "pending_upload" &&
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    await db
      .from("upload_sessions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "pending_upload");
    return failure(410, { detail: "Upload session expired" });
  }
  const files = await loadSessionFiles(db, session.id);
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file) return failure(404, { detail: "Upload file not found" });

  try {
    const result = await completeSessionFile(db, session, file, userId, failed);
    const updated = await loadOwnedSession(db, session.id, userId);
    const currentFiles = await loadSessionFiles(db, session.id);
    if (result === "incomplete") {
      return failure(409, {
        code: "upload_incomplete",
        detail: "The uploaded file is not available yet.",
        session: updated,
        files: currentFiles.map(publicFile),
      });
    }
    return {
      ok: true,
      data: {
        status: result === "in_progress" ? 202 : 200,
        body: { session: updated, files: currentFiles.map(publicFile) },
      },
    };
  } catch (error) {
    // Object storage being unreachable is not the caller's fault and is worth
    // retrying, so it answers 503 rather than the generic 500.
    if (error instanceof StorageOperationError) {
      return internalFailure(error, 503);
    }
    throw error;
  }
}

/**
 * Cancel a session and drop the objects it staged. Only a pending session —
 * or one whose verification lease has gone stale — can be cancelled: files
 * already handed to the worker must not have their bytes pulled away.
 */
export async function cancelUploadSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<null>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  const staleVerification =
    session.status === "verifying" &&
    new Date(session.updated_at).getTime() <=
      Date.now() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000;
  if (session.status !== "pending_upload" && !staleVerification) {
    return failure(409, { detail: "Upload session cannot be cancelled" });
  }
  const files = await loadSessionFiles(db, session.id);
  if (
    files.some((file) =>
      ["uploaded", "processing", "completed"].includes(file.status),
    )
  ) {
    return failure(409, {
      detail: "Files already being processed cannot be cancelled",
    });
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
  if (error) return internalFailure(error);
  if (!cancelled) {
    return failure(409, {
      detail:
        "Upload session is already being completed and cannot be cancelled",
    });
  }

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
  if (cleanupError) return internalFailure(cleanupError);
  return { ok: true, data: null };
}
