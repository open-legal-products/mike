import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { recordAudit } from "./audit";
import { convertedPdfKey, docxToPdf } from "./convert";
import { shouldConvertToPdf } from "./documentTypes";
import { contentSha256 } from "./documentVersions";
import {
  copyFile,
  deleteFile,
  downloadFile,
  storageKey,
  uploadFile,
  versionStorageKey,
  workflowReferenceKey,
} from "./storage";
import { createServerSupabase } from "./supabase";
import { UPLOAD_VERIFICATION_LEASE_SECONDS } from "./uploadSessions";

type Db = ReturnType<typeof createServerSupabase>;

type UploadSessionRow = {
  id: string;
  user_id: string;
  purpose:
    | "document_create"
    | "document_version_create"
    | "document_version_replace"
    | "workflow_reference_create"
    | "workflow_reference_replace";
  destination: Record<string, unknown>;
  status: string;
};

type UploadFileRow = {
  id: string;
  session_id: string;
  resource_id: string;
  client_id: string;
  filename: string;
  file_type: string;
  content_type: string;
  expected_size_bytes: number;
  sealed_storage_path: string;
  target_folder_id: string | null;
  status: string;
  error_code: string | null;
};

type UploadJobRow = {
  id: string;
  session_id: string;
  attempts: number;
  locked_by: string | null;
};

export const UPLOAD_JOB_MAX_ATTEMPTS = 3;
export const UPLOAD_JOB_LEASE_SECONDS = 30 * 60;
const UPLOAD_WORKER_POLL_MS = 1_000;
const UPLOAD_WORKER_HEARTBEAT_MS = 60_000;
const UPLOAD_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_UPLOAD_ERROR_CODES = new Set([
  "direct_upload_failed",
  "size_mismatch",
  "content_type_mismatch",
]);

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function countPdfPages(bytes: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (options: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    // pdf.js may transfer/detach the supplied buffer. Page counting must not
    // consume the bytes that are subsequently hashed and persisted.
    ).getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function buildPdfRendition(args: {
  bytes: ArrayBuffer;
  fileType: string;
  userId: string;
  documentId: string;
  versionSlug?: string;
  sourceStoragePath: string;
}): Promise<string | null> {
  if (args.fileType === "pdf") return args.sourceStoragePath;
  if (!shouldConvertToPdf(args.fileType)) return null;
  try {
    const pdf = await docxToPdf(Buffer.from(args.bytes));
    const key = args.versionSlug
      ? `converted-pdfs/${args.userId}/${args.documentId}/${args.versionSlug}.pdf`
      : convertedPdfKey(args.userId, args.documentId);
    await uploadFile(key, arrayBufferFromBuffer(pdf), "application/pdf");
    return key;
  } catch (error) {
    console.error("[upload-worker] document conversion failed", {
      documentId: args.documentId,
      fileType: args.fileType,
      error,
    });
    return null;
  }
}

async function requireSealedBytes(file: UploadFileRow): Promise<ArrayBuffer> {
  const bytes = await downloadFile(file.sealed_storage_path);
  if (!bytes) throw new Error("sealed_upload_not_found");
  if (bytes.byteLength !== file.expected_size_bytes) {
    throw new Error("sealed_upload_size_mismatch");
  }
  return bytes;
}

async function processCreatedDocument(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  bytes: ArrayBuffer,
) {
  const destination = session.destination;
  const scope = destination.scope as "standalone" | "project" | "library";
  const projectId =
    scope === "project" ? (destination.project_id as string) : null;
  const folderId =
    scope === "project"
      ? (file.target_folder_id ??
        (destination.folder_id as string | null | undefined) ??
        null)
      : null;
  const libraryFolderId =
    scope === "library"
      ? (file.target_folder_id ??
        (destination.folder_id as string | null | undefined) ??
        null)
      : null;
  const libraryKind =
    scope === "library"
      ? (destination.library_kind as "file" | "template")
      : "file";
  const documentId = file.resource_id;
  const versionId = file.id;

  const { error: documentError } = await db.from("documents").upsert(
    {
      id: documentId,
      project_id: projectId,
      user_id: session.user_id,
      status: "processing",
      folder_id: folderId,
      library_kind: libraryKind,
      library_folder_id: libraryFolderId,
    },
    { onConflict: "id" },
  );
  if (documentError) throw documentError;

  const sourcePath = storageKey(session.user_id, documentId, file.filename);
  await copyFile(file.sealed_storage_path, sourcePath);
  const pdfPath = await buildPdfRendition({
    bytes,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(bytes) : null;

  const { error: versionError } = await db.from("document_versions").upsert(
    {
      id: versionId,
      document_id: documentId,
      storage_path: sourcePath,
      pdf_storage_path: pdfPath,
      source: "upload",
      version_number: 1,
      filename: file.filename,
      file_type: file.file_type,
      size_bytes: bytes.byteLength,
      page_count: pageCount,
      content_sha256: contentSha256(bytes),
    },
    { onConflict: "id" },
  );
  if (versionError) throw versionError;

  const { data: document, error: updateError } = await db
    .from("documents")
    .update({
      current_version_id: versionId,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .eq("user_id", session.user_id)
    .select("*")
    .single();
  if (updateError || !document) {
    throw updateError ?? new Error("document_update_returned_no_data");
  }

  await recordAudit(db, {
    userId: session.user_id,
    action: "document.uploaded",
    title: file.filename,
    surface: projectId ? "project" : "assistant",
    projectId,
    documentId,
  });

  return {
    ...document,
    filename: file.filename,
    storage_path: sourcePath,
    pdf_storage_path: pdfPath,
    folder_id:
      scope === "library"
        ? ((document.library_folder_id as string | null | undefined) ?? null)
        : ((document.folder_id as string | null | undefined) ?? null),
    file_type: file.file_type,
    size_bytes: bytes.byteLength,
    page_count: pageCount,
    active_version_number: 1,
  };
}

async function processNewDocumentVersion(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  bytes: ArrayBuffer,
) {
  const documentId = session.destination.document_id as string;
  const versionId = file.resource_id;
  const requestedFilename =
    (session.destination.filename as string | undefined)?.trim() ||
    file.filename;
  const versionSlug = versionId.replace(/-/g, "");
  const sourcePath = versionStorageKey(
    session.user_id,
    documentId,
    versionSlug,
    file.filename,
  );
  await copyFile(file.sealed_storage_path, sourcePath);
  const pdfPath = await buildPdfRendition({
    bytes,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    versionSlug,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(bytes) : null;

  const { data: existing, error: existingError } = await db
    .from("document_versions")
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
    )
    .eq("id", versionId)
    .eq("document_id", documentId)
    .maybeSingle();
  if (existingError) throw existingError;

  let version = existing;
  if (!version) {
    const { data: maxRow, error: maxError } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw maxError;
    const nextVersionNumber =
      ((maxRow?.version_number as number | null) ?? 1) + 1;
    const { data, error } = await db
      .from("document_versions")
      .insert({
        id: versionId,
        document_id: documentId,
        storage_path: sourcePath,
        pdf_storage_path: pdfPath,
        source: "user_upload",
        version_number: nextVersionNumber,
        filename: requestedFilename,
        file_type: file.file_type,
        size_bytes: bytes.byteLength,
        page_count: pageCount,
        content_sha256: contentSha256(bytes),
      })
      .select(
        "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
      )
      .single();
    if (error || !data)
      throw error ?? new Error("version_insert_returned_no_data");
    version = data;
  }

  const { error: documentError } = await db
    .from("documents")
    .update({
      current_version_id: versionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);
  if (documentError) throw documentError;
  return version;
}

async function processReplacementDocumentVersion(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  bytes: ArrayBuffer,
) {
  const documentId = session.destination.document_id as string;
  const versionId = session.destination.version_id as string;
  const { data: current, error: currentError } = await db
    .from("document_versions")
    .select(
      "id, storage_path, pdf_storage_path, version_number, source, created_at",
    )
    .eq("id", versionId)
    .eq("document_id", documentId)
    .is("deleted_at", null)
    .single();
  if (currentError || !current) {
    throw currentError ?? new Error("version_not_found");
  }

  const versionSlug = file.resource_id.replace(/-/g, "");
  const sourcePath = versionStorageKey(
    session.user_id,
    documentId,
    versionSlug,
    file.filename,
  );
  await copyFile(file.sealed_storage_path, sourcePath);
  const pdfPath = await buildPdfRendition({
    bytes,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    versionSlug,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(bytes) : null;
  const { data: updated, error } = await db
    .from("document_versions")
    .update({
      storage_path: sourcePath,
      pdf_storage_path: pdfPath,
      filename: file.filename,
      file_type: file.file_type,
      size_bytes: bytes.byteLength,
      page_count: pageCount,
      content_sha256: contentSha256(bytes),
      created_at: new Date().toISOString(),
    })
    .eq("id", versionId)
    .eq("document_id", documentId)
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
    )
    .single();
  if (error || !updated)
    throw error ?? new Error("version_update_returned_no_data");

  const obsolete = new Set<string>([
    current.storage_path as string,
    current.pdf_storage_path as string,
  ]);
  obsolete.delete(sourcePath);
  if (pdfPath) obsolete.delete(pdfPath);
  for (const path of obsolete) {
    if (path) await deleteFile(path).catch(() => {});
  }
  return updated;
}

async function processWorkflowReference(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  bytes: ArrayBuffer,
) {
  const workflowId = session.destination.workflow_id as string;
  const replacing = session.purpose === "workflow_reference_replace";
  const referenceId = replacing
    ? (session.destination.reference_id as string)
    : file.resource_id;
  const { data: workflow, error: workflowError } = await db
    .from("workflows")
    .select("id, user_id")
    .eq("id", workflowId)
    .single();
  if (workflowError || !workflow) {
    throw workflowError ?? new Error("workflow_not_found");
  }
  const ownerId = (workflow.user_id as string | null) ?? session.user_id;
  const hash = contentSha256(bytes);
  const sourcePath = workflowReferenceKey(
    ownerId,
    workflowId,
    referenceId,
    hash,
    file.filename,
  );
  await copyFile(file.sealed_storage_path, sourcePath);

  let oldPath: string | null = null;
  if (replacing) {
    const { data: current, error } = await db
      .from("workflow_reference_documents")
      .select("id, storage_path")
      .eq("id", referenceId)
      .eq("workflow_id", workflowId)
      .single();
    if (error || !current) throw error ?? new Error("reference_not_found");
    oldPath = current.storage_path as string;
  }

  const payload = {
    id: referenceId,
    workflow_id: workflowId,
    user_id: ownerId,
    filename: file.filename,
    file_type: file.file_type,
    storage_path: sourcePath,
    size_bytes: bytes.byteLength,
    content_hash: hash,
    updated_at: new Date().toISOString(),
  };
  const query = replacing
    ? db
        .from("workflow_reference_documents")
        .update(payload)
        .eq("id", referenceId)
        .eq("workflow_id", workflowId)
    : db
        .from("workflow_reference_documents")
        .upsert(payload, { onConflict: "id" });
  const { data: reference, error } = await query
    .select(
      "id, workflow_id, filename, file_type, size_bytes, created_at, updated_at",
    )
    .single();
  if (error || !reference) {
    throw error ?? new Error("reference_write_returned_no_data");
  }
  if (oldPath && oldPath !== sourcePath) {
    await deleteFile(oldPath).catch(() => {});
  }
  return reference;
}

export async function processUploadFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
) {
  const bytes = await requireSealedBytes(file);
  switch (session.purpose) {
    case "document_create":
      return processCreatedDocument(db, session, file, bytes);
    case "document_version_create":
      return processNewDocumentVersion(db, session, file, bytes);
    case "document_version_replace":
      return processReplacementDocumentVersion(db, session, file, bytes);
    case "workflow_reference_create":
    case "workflow_reference_replace":
      return processWorkflowReference(db, session, file, bytes);
  }
}

async function heartbeatJob(db: Db, jobId: string, workerId: string) {
  const { data, error } = await db
    .from("upload_processing_jobs")
    .update({
      locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "running")
    .eq("locked_by", workerId)
    .select("id")
    .maybeSingle();
  if (error || !data) throw error ?? new Error("upload_job_lease_lost");
}

async function markCreatedDocumentFailed(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
): Promise<void> {
  if (session.purpose !== "document_create") return;
  const { error } = await db
    .from("documents")
    .update({ status: "error", updated_at: new Date().toISOString() })
    .eq("id", file.resource_id)
    .eq("user_id", session.user_id)
    .eq("status", "processing");
  if (error) throw error;
}

async function removeFailedCreatedDocument(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
): Promise<void> {
  if (session.purpose !== "document_create") return;
  await Promise.all([
    deleteFile(storageKey(session.user_id, file.resource_id, file.filename)).catch(
      () => {},
    ),
    deleteFile(convertedPdfKey(session.user_id, file.resource_id)).catch(
      () => {},
    ),
  ]);
  const { error } = await db
    .from("documents")
    .delete()
    .eq("id", file.resource_id)
    .eq("user_id", session.user_id)
    .eq("status", "error")
    .is("current_version_id", null);
  if (error) throw error;
}

export async function processUploadJob(
  db: Db,
  jobId: string,
  workerId: string,
): Promise<void> {
  const { data: job, error: jobError } = await db
    .from("upload_processing_jobs")
    .select("id, session_id, attempts, locked_by")
    .eq("id", jobId)
    .eq("status", "running")
    .eq("locked_by", workerId)
    .single();
  if (jobError || !job) throw jobError ?? new Error("upload_job_not_found");
  const typedJob = job as UploadJobRow;
  const { data: session, error: sessionError } = await db
    .from("upload_sessions")
    .select("id, user_id, purpose, destination, status")
    .eq("id", typedJob.session_id)
    .single();
  if (sessionError || !session) {
    throw sessionError ?? new Error("upload_session_not_found");
  }
  const typedSession = session as UploadSessionRow;
  const { data: fileRows, error: filesError } = await db
    .from("upload_session_files")
    .select("*")
    .eq("session_id", typedSession.id)
    .order("created_at", { ascending: true });
  if (filesError) throw filesError;
  const files = (fileRows ?? []) as UploadFileRow[];
  const terminalUploadFailureCount = files.filter(
    (file) =>
      file.status === "error" &&
      !!file.error_code &&
      TERMINAL_UPLOAD_ERROR_CODES.has(file.error_code),
  ).length;

  const heartbeat = setInterval(() => {
    void heartbeatJob(db, jobId, workerId).catch((error) => {
      console.error("[upload-worker] heartbeat failed", { jobId, error });
    });
  }, UPLOAD_WORKER_HEARTBEAT_MS);
  heartbeat.unref();

  let failed = 0;
  const processingFailures: UploadFileRow[] = [];
  try {
    for (const file of files) {
      if (
        file.status === "completed" ||
        (file.status === "error" &&
          !!file.error_code &&
          TERMINAL_UPLOAD_ERROR_CODES.has(file.error_code))
      ) {
        continue;
      }
      await heartbeatJob(db, jobId, workerId);
      const { error: statusError } = await db
        .from("upload_session_files")
        .update({
          status: "processing",
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", typedSession.id);
      if (statusError) throw statusError;

      let result: unknown;
      try {
        result = await processUploadFile(db, typedSession, file);
      } catch (error) {
        // A failed timer heartbeat makes ownership uncertain. Re-prove the
        // lease before recording even a failure result.
        await heartbeatJob(db, jobId, workerId);
        failed += 1;
        processingFailures.push(file);
        console.error("[upload-worker] file processing failed", {
          jobId,
          sessionId: typedSession.id,
          fileId: file.id,
          purpose: typedSession.purpose,
          error,
        });
        const { error: updateError } = await db
          .from("upload_session_files")
          .update({
            status: "error",
            error_code: "processing_failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", file.id)
          .eq("session_id", typedSession.id);
        if (updateError) throw updateError;
        await markCreatedDocumentFailed(db, typedSession, file);
        await heartbeatJob(db, jobId, workerId);
        continue;
      }

      // Long conversions may outlive a lease heartbeat. Re-prove ownership
      // before publishing the result or deleting the sealed source object.
      await heartbeatJob(db, jobId, workerId);
      const { error } = await db
        .from("upload_session_files")
        .update({
          status: "completed",
          result,
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", typedSession.id);
      if (error) throw error;
      await deleteFile(file.sealed_storage_path).catch(() => {});
      await heartbeatJob(db, jobId, workerId);
    }
  } finally {
    clearInterval(heartbeat);
  }

  const now = new Date().toISOString();
  if (failed > 0 && typedJob.attempts < UPLOAD_JOB_MAX_ATTEMPTS) {
    const retryAt = new Date(
      Date.now() + typedJob.attempts * 5_000,
    ).toISOString();
    const { data: retried, error: retryError } = await db
      .from("upload_processing_jobs")
      .update({
        status: "queued",
        available_at: retryAt,
        locked_at: null,
        locked_by: null,
        error_code: "file_processing_failed",
        updated_at: now,
      })
      .eq("id", jobId)
      .eq("locked_by", workerId)
      .select("id")
      .maybeSingle();
    if (retryError || !retried) {
      throw retryError ?? new Error("upload_job_lease_lost");
    }
    const { error: sessionUpdateError } = await db
      .from("upload_sessions")
      .update({ status: "uploaded", error_code: null, updated_at: now })
      .eq("id", typedSession.id);
    if (sessionUpdateError) throw sessionUpdateError;
    return;
  }

  const partialFailure = failed > 0 || terminalUploadFailureCount > 0;
  if (partialFailure) {
    for (const file of processingFailures) {
      await removeFailedCreatedDocument(db, typedSession, file);
    }
    const { data: failedFiles } = await db
      .from("upload_session_files")
      .select("sealed_storage_path")
      .eq("session_id", typedSession.id)
      .eq("status", "error");
    for (const failedFile of failedFiles ?? []) {
      if (failedFile.sealed_storage_path) {
        await deleteFile(failedFile.sealed_storage_path).catch(() => {});
      }
    }
  }
  const { data: finished, error: finishError } = await db
    .from("upload_processing_jobs")
    .update({
      status: "completed",
      locked_at: null,
      locked_by: null,
      error_code: partialFailure ? "partial_failure" : null,
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("locked_by", workerId)
    .select("id")
    .maybeSingle();
  if (finishError || !finished) {
    throw finishError ?? new Error("upload_job_lease_lost");
  }
  const { error: sessionFinishError } = await db
    .from("upload_sessions")
    .update({
      status: "completed",
      completed_at: now,
      error_code: partialFailure ? "partial_failure" : null,
      cleaned_at: now,
      updated_at: now,
    })
    .eq("id", typedSession.id);
  if (sessionFinishError) throw sessionFinishError;
}

export async function cleanupUploadSessions(db: Db): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const { error: expireError } = await db
    .from("upload_sessions")
    .update({
      status: "expired",
      error_code: "session_expired",
      updated_at: nowIso,
    })
    .eq("status", "pending_upload")
    .lt("expires_at", nowIso);
  if (expireError) throw expireError;

  const verificationCutoff = new Date(
    now.getTime() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000,
  ).toISOString();
  const { error: verificationError } = await db
    .from("upload_sessions")
    .update({
      status: "error",
      error_code: "verification_timeout",
      updated_at: nowIso,
    })
    .eq("status", "verifying")
    .lt("updated_at", verificationCutoff);
  if (verificationError) throw verificationError;

  const staleLease = new Date(
    now.getTime() - UPLOAD_JOB_LEASE_SECONDS * 1000,
  ).toISOString();
  const { data: exhaustedJobs, error: exhaustedError } = await db
    .from("upload_processing_jobs")
    .select("id, session_id")
    .eq("status", "running")
    .gte("attempts", UPLOAD_JOB_MAX_ATTEMPTS)
    .lt("locked_at", staleLease)
    .limit(20);
  if (exhaustedError) throw exhaustedError;
  for (const job of exhaustedJobs ?? []) {
    const { error: jobError } = await db
      .from("upload_processing_jobs")
      .update({
        status: "error",
        locked_at: null,
        locked_by: null,
        error_code: "retry_limit_exceeded",
        updated_at: nowIso,
      })
      .eq("id", job.id)
      .eq("status", "running");
    if (jobError) throw jobError;
    const { error: sessionError } = await db
      .from("upload_sessions")
      .update({
        status: "error",
        error_code: "processing_failed",
        updated_at: nowIso,
      })
      .eq("id", job.session_id)
      .eq("status", "processing");
    if (sessionError) throw sessionError;
  }

  const { data: sessions, error: sessionsError } = await db
    .from("upload_sessions")
    .select("id")
    .in("status", ["expired", "cancelled", "error"])
    .is("cleaned_at", null)
    .limit(20);
  if (sessionsError) throw sessionsError;
  for (const session of sessions ?? []) {
    const { data: files, error: filesError } = await db
      .from("upload_session_files")
      .select("staging_storage_path, sealed_storage_path")
      .eq("session_id", session.id);
    if (filesError) throw filesError;
    for (const file of files ?? []) {
      await Promise.all([
        file.staging_storage_path
          ? deleteFile(file.staging_storage_path).catch(() => {})
          : Promise.resolve(),
        file.sealed_storage_path
          ? deleteFile(file.sealed_storage_path).catch(() => {})
          : Promise.resolve(),
      ]);
    }
    const { error } = await db
      .from("upload_sessions")
      .update({ cleaned_at: nowIso, updated_at: nowIso })
      .eq("id", session.id)
      .is("cleaned_at", null);
    if (error) throw error;
  }

  const retentionCutoff = new Date(
    now.getTime() - UPLOAD_SESSION_RETENTION_MS,
  ).toISOString();
  const { data: retained, error: retentionError } = await db
    .from("upload_sessions")
    .select("id")
    .in("status", ["completed", "expired", "cancelled", "error"])
    .not("cleaned_at", "is", null)
    .lt("updated_at", retentionCutoff)
    .limit(20);
  if (retentionError) throw retentionError;
  const retainedIds = (retained ?? []).map((session) => session.id);
  if (retainedIds.length > 0) {
    const { error } = await db
      .from("upload_sessions")
      .delete()
      .in("id", retainedIds);
    if (error) throw error;
  }
}

async function claimNextUploadJob(db: Db, workerId: string) {
  const { data, error } = await db.rpc("claim_upload_processing_job", {
    target_worker_id: workerId,
    target_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

export function startUploadProcessingWorker() {
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastCleanupAt = 0;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const db = createServerSupabase();
      if (Date.now() - lastCleanupAt >= 60_000) {
        await cleanupUploadSessions(db);
        lastCleanupAt = Date.now();
      }
      const jobId = await claimNextUploadJob(db, workerId);
      if (!jobId) {
        schedule(UPLOAD_WORKER_POLL_MS);
        return;
      }
      await processUploadJob(db, jobId, workerId);
      schedule(0);
    } catch (error) {
      console.error("[upload-worker] iteration failed", { workerId, error });
      schedule(UPLOAD_WORKER_POLL_MS);
    }
  };

  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
