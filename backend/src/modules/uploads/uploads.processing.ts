import {
  createDocumentVersion,
  updateDocumentVersion,
} from "../documents/documents.service";
// Background processing for sealed upload-session files.
//
// The upload protocol has two halves: the HTTP control plane in
// uploads.routes.ts / uploads.sessions.ts, which hands the browser signed URLs
// and seals what it uploads, and this file, which turns a sealed object into
// the document, version, or replacement the session asked for. It runs on the
// worker (see workerRuntime.ts, which reaches it through uploads.service.ts),
// not on a request, so everything here is DB + storage orchestration with no
// req/res in sight.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { resolveContentOrgId } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import { convertedPdfKey, officeFileToPdf } from "../../lib/convert";
import { reportError } from "../../lib/observability/sentry";
import { shouldConvertToPdf } from "../../lib/documentTypes";
import { uploadJobWallClockMs } from "../../lib/runtimeConfig";
import {
  copyFile,
  createFileReadStream,
  deleteFile,
  deleteFileBestEffort,
  StorageOperationError,
  storageKey,
  uploadFileFromPath,
  versionStorageKey,
} from "../../lib/storage";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { UPLOAD_VERIFICATION_LEASE_SECONDS } from "./uploads.manifest";

type UploadSessionRow = {
  id: string;
  user_id: string;
  user_email: string | null;
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
  /**
   * When the worker wrote the destination documents row for this file. Null
   * until then, so a retry can tell "never created" from "created, then
   * deleted by the user" — the attempt counter cannot make that distinction.
   */
  document_created_at: string | null;
};

type UploadJobRow = {
  id: string;
  session_id: string;
  file_id: string;
  attempts: number;
  locked_by: string | null;
};

export const UPLOAD_JOB_MAX_ATTEMPTS = 3;
export const UPLOAD_JOB_LEASE_SECONDS = 30 * 60;
const UPLOAD_WORKER_POLL_MS = 1_000;
const UPLOAD_WORKER_HEARTBEAT_MS = 60_000;
const UPLOAD_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TEMP_RETENTION_MS = 2 * UPLOAD_JOB_LEASE_SECONDS * 1000;
const TERMINAL_UPLOAD_ERROR_CODES = new Set([
  "direct_upload_failed",
  "size_mismatch",
  "content_type_mismatch",
  // The destination document no longer exists. Retrying cannot make it exist
  // again — it can only put it back, which is the bug this code prevents.
  "document_deleted",
]);

/**
 * The document this upload was destined for was deleted while it processed.
 *
 * Less a failure of the upload than a race the user already resolved: they
 * asked for the document to go, and it went. The only correct outcome is to
 * stop, mark the file failed, and clean up whatever bytes this job wrote —
 * never to recreate the row.
 */
class DeletedDocumentError extends Error {
  /** Objects this job uploaded that nothing will reference now. */
  readonly orphanedKeys: string[];

  constructor(documentId: string, orphanedKeys: (string | null)[] = []) {
    super(`document_deleted:${documentId}`);
    this.name = "DeletedDocumentError";
    this.orphanedKeys = orphanedKeys.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  }
}

/**
 * create_document_version raises document_not_found (P0002) when the parent
 * row is gone. Before the lifecycle RPCs the same race surfaced as a foreign
 * key violation (23503) on the versions insert; both are recognised so this
 * still holds if a caller ever inserts directly again.
 */
function isMissingDocumentError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (code === "P0002" || code === "23503") return true;
  return typeof message === "string" && message.includes("document_not_found");
}

type SealedFileArtifact = {
  directory: string;
  filePath: string;
  size: number;
  sha256: string;
};

async function countPdfPages(filePath: string): Promise<number | null> {
  let loadingTask:
    | {
        promise: Promise<{ numPages: number }>;
        destroy?: () => Promise<void>;
      }
    | undefined;
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    loadingTask = (
      pdfjsLib as unknown as {
        getDocument: (options: unknown) => {
          promise: Promise<{ numPages: number }>;
          destroy?: () => Promise<void>;
        };
      }
    ).getDocument({ url: pathToFileURL(filePath).href });
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } catch {
    return null;
  } finally {
    await loadingTask?.destroy?.().catch(() => {});
  }
}

async function buildPdfRendition(args: {
  sourceFilePath: string;
  workingDirectory: string;
  fileType: string;
  userId: string;
  documentId: string;
  versionSlug?: string;
  sourceStoragePath: string;
}): Promise<string | null> {
  if (args.fileType === "pdf") return args.sourceStoragePath;
  if (!shouldConvertToPdf(args.fileType)) return null;
  try {
    const pdfPath = await officeFileToPdf(
      args.sourceFilePath,
      args.workingDirectory,
    );
    const key = args.versionSlug
      ? `converted-pdfs/${args.userId}/${args.documentId}/${args.versionSlug}.pdf`
      : convertedPdfKey(args.userId, args.documentId);
    await uploadFileFromPath(key, pdfPath, "application/pdf");
    return key;
  } catch (error) {
    // Non-fatal for the upload (the original stays usable) but a conversion
    // that fails is either a LibreOffice regression or a malformed file we
    // should know about — grouped by file type so a format-wide break is one
    // issue with a count, not noise.
    reportError(error, {
      level: "warning",
      tags: {
        component: "upload-worker",
        stage: "conversion",
        file_type: args.fileType,
      },
      extra: { document_id: args.documentId },
      fingerprint: ["upload-conversion-failed", args.fileType],
    });
    console.error("[upload-worker] document conversion failed", {
      documentId: args.documentId,
      fileType: args.fileType,
      error,
    });
    return null;
  }
}

async function removeTemporaryArtifact(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch((error) => {
    console.error("[upload-worker] temporary file cleanup failed", {
      directory,
      error,
    });
  });
}

function uploadProcessingTempRoot(): string {
  return process.env.UPLOAD_PROCESSING_TEMP_DIR?.trim() || tmpdir();
}

export async function cleanupUploadProcessingTempFiles(
  now = Date.now(),
): Promise<void> {
  const root = uploadProcessingTempRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("mike-upload-"),
      )
      .map(async (entry) => {
        const directory = join(root, entry.name);
        const metadata = await stat(directory).catch(() => null);
        if (!metadata || now - metadata.mtimeMs < UPLOAD_TEMP_RETENTION_MS) {
          return;
        }
        await removeTemporaryArtifact(directory);
      }),
  );
}

async function requireSealedFile(
  file: UploadFileRow,
): Promise<SealedFileArtifact> {
  const temporaryRoot = uploadProcessingTempRoot();
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "mike-upload-"));
  const extension = /^[a-z0-9]{1,16}$/.test(file.file_type)
    ? file.file_type
    : "bin";
  const filePath = join(directory, `source.${extension}`);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      createFileReadStream(file.sealed_storage_path),
      meter,
      createWriteStream(filePath, { flags: "wx" }),
    );
    if (size !== file.expected_size_bytes) {
      throw new Error("sealed_upload_size_mismatch");
    }
    return {
      directory,
      filePath,
      size,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    await removeTemporaryArtifact(directory);
    if (error instanceof StorageOperationError) {
      throw new Error("sealed_upload_not_found", { cause: error });
    }
    throw error;
  }
}

async function processCreatedDocument(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  artifact: SealedFileArtifact,
) {
  const destination = session.destination;
  const scope = destination.scope as
    | "standalone"
    | "project"
    | "library"
    | "workflow";
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
    scope === "workflow"
      ? "workflow_asset"
      : scope === "library"
        ? (destination.library_kind as "file" | "template")
        : "file";
  const workflowId =
    scope === "workflow" ? (destination.workflow_id as string) : null;
  const documentId = file.resource_id;
  const versionId = file.id;

  // A document created inside an org project belongs to the organization —
  // the org_id stamp is an authorization input, so a failed lookup must fail
  // the job (the durable worker retries) rather than quietly filing a firm's
  // document as personal content.
  const resolvedOrg = await resolveContentOrgId(db, { projectId });
  if (!resolvedOrg.ok) throw new Error(resolvedOrg.detail);
  let orgId = resolvedOrg.orgId;
  if (!orgId && workflowId) {
    // A workflow asset belongs to its workflow's tenant: an org workflow's
    // assets must survive their uploader's account the way the workflow does.
    const { data: workflowRow, error: workflowError } = await db
      .from("workflows")
      .select("org_id")
      .eq("id", workflowId)
      .maybeSingle();
    if (workflowError) throw new Error(workflowError.message);
    orgId = (workflowRow as { org_id?: string | null } | null)?.org_id ?? null;
  }

  // The upsert below is what makes a retry idempotent — and, on a retry, what
  // would silently RESURRECT a document the user deleted while this job was
  // running. Only a row this job already wrote can have been deleted: the
  // marker on the file row is set right after a successful upsert, so
  // "marker set, row missing" means removed, while "marker unset, row
  // missing" means an earlier attempt failed before it got this far (a
  // storage read, the org lookup, the upsert itself) and the row is still
  // ours to create. The attempt counter cannot tell those two apart.
  if (file.document_created_at) {
    const { data: existing, error: existingError } = await db
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing)
      throw new DeletedDocumentError(documentId, [
        storageKey(session.user_id, documentId, file.filename),
        convertedPdfKey(session.user_id, documentId),
      ]);
  }

  const { error: documentError } = await db.from("documents").upsert(
    {
      id: documentId,
      project_id: projectId,
      user_id: session.user_id,
      status: "processing",
      org_id: orgId,
      folder_id: folderId,
      library_kind: libraryKind,
      library_folder_id: libraryFolderId,
      workflow_id: workflowId,
    },
    { onConflict: "id" },
  );
  if (documentError) throw documentError;

  // Remember that the row now exists before writing anything else, so a
  // retry after any later failure checks for deletion instead of recreating.
  // (Re-stamping on a retry that had the marker already is harmless.)
  if (!file.document_created_at) {
    const stampedAt = new Date().toISOString();
    const { error: markerError } = await db
      .from("upload_session_files")
      .update({ document_created_at: stampedAt, updated_at: stampedAt })
      .eq("id", file.id)
      .eq("session_id", session.id);
    if (markerError) throw markerError;
  }

  const sourcePath = storageKey(session.user_id, documentId, file.filename);
  await copyFile(file.sealed_storage_path, sourcePath);
  const pdfPath = await buildPdfRendition({
    sourceFilePath: artifact.filePath,
    workingDirectory: artifact.directory,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(artifact.filePath) : null;

  const { error: versionError } = await createDocumentVersion(db, {
    id: versionId,
    document_id: documentId,
    storage_path: sourcePath,
    pdf_storage_path: pdfPath,
    source: "upload",
    version_number: 1,
    filename: file.filename,
    file_type: file.file_type,
    size_bytes: artifact.size,
    page_count: pageCount,
    content_sha256: artifact.sha256,
  });
  // The document went while we were converting: stop, and hand the bytes we
  // just uploaded to cleanup rather than leaving them for a retry to adopt.
  if (versionError && isMissingDocumentError(versionError))
    throw new DeletedDocumentError(documentId, [sourcePath, pdfPath]);
  if (versionError) throw versionError;

  const { data: document, error: updateError } = await db
    .from("documents")
    .update({
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
    userEmail: session.user_email,
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
    size_bytes: artifact.size,
    page_count: pageCount,
    active_version_number: 1,
  };
}

async function processNewDocumentVersion(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  artifact: SealedFileArtifact,
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
    sourceFilePath: artifact.filePath,
    workingDirectory: artifact.directory,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    versionSlug,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(artifact.filePath) : null;

  const { data: version, error } = await createDocumentVersion(db, {
    id: versionId,
    document_id: documentId,
    storage_path: sourcePath,
    pdf_storage_path: pdfPath,
    source: "user_upload",

    filename: requestedFilename,
    file_type: file.file_type,
    size_bytes: artifact.size,
    page_count: pageCount,
    content_sha256: artifact.sha256,
  });
  // Adding a version to a document that has been deleted is the same race as
  // the create path, with the same answer: stop, and clean up these bytes.
  if (error && isMissingDocumentError(error))
    throw new DeletedDocumentError(documentId, [sourcePath, pdfPath]);
  if (error || !version)
    throw error ?? new Error("version_insert_returned_no_data");

  const {
    id,
    version_number,
    source,
    created_at,
    filename,
    file_type,
    size_bytes,
    page_count,
  } = version;
  return {
    id,
    version_number,
    source,
    created_at,
    filename,
    file_type,
    size_bytes,
    page_count,
  };
}

async function processReplacementDocumentVersion(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  artifact: SealedFileArtifact,
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
    sourceFilePath: artifact.filePath,
    workingDirectory: artifact.directory,
    fileType: file.file_type,
    userId: session.user_id,
    documentId,
    versionSlug,
    sourceStoragePath: sourcePath,
  });
  const pageCount =
    file.file_type === "pdf" ? await countPdfPages(artifact.filePath) : null;
  const { data: updated, error } = await updateDocumentVersion(
    db,
    documentId,
    versionId,
    {
      storage_path: sourcePath,
      pdf_storage_path: pdfPath,
      filename: file.filename,
      file_type: file.file_type,
      size_bytes: artifact.size,
      page_count: pageCount,
      content_sha256: artifact.sha256,
      created_at: new Date().toISOString(),
    },
  );
  if (error || !updated)
    throw error ?? new Error("version_update_returned_no_data");

  return updated;
}

export async function processUploadFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
) {
  const artifact = await requireSealedFile(file);
  try {
    switch (session.purpose) {
      case "document_create":
        return await processCreatedDocument(db, session, file, artifact);
      case "document_version_create":
        return await processNewDocumentVersion(db, session, file, artifact);
      case "document_version_replace":
        return await processReplacementDocumentVersion(
          db,
          session,
          file,
          artifact,
        );
      case "workflow_reference_create":
        // Complete upload sessions created by the previous release using the
        // standard workflow-asset document path.
        return await processCreatedDocument(
          db,
          {
            ...session,
            purpose: "document_create",
            destination: {
              scope: "workflow",
              workflow_id: session.destination.workflow_id,
            },
          },
          file,
          artifact,
        );
      case "workflow_reference_replace":
        // A former replacement is retained as a new version so history is not
        // destroyed during a rolling deployment.
        return await processNewDocumentVersion(
          db,
          {
            ...session,
            purpose: "document_version_create",
            destination: {
              document_id: session.destination.reference_id,
              filename: file.filename,
            },
          },
          file,
          artifact,
        );
    }
  } finally {
    await removeTemporaryArtifact(artifact.directory);
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

async function refreshUploadSessionStatus(
  db: Db,
  sessionId: string,
): Promise<void> {
  const { error } = await db.rpc("refresh_upload_session_status", {
    target_session_id: sessionId,
  });
  if (error) throw error;
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
    deleteFileBestEffort(
      storageKey(session.user_id, file.resource_id, file.filename),
      "failed-document-remove",
    ),
    deleteFileBestEffort(
      convertedPdfKey(session.user_id, file.resource_id),
      "failed-document-remove",
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
    .select("id, session_id, file_id, attempts, locked_by")
    .eq("id", jobId)
    .eq("status", "running")
    .eq("locked_by", workerId)
    .single();
  if (jobError || !job) throw jobError ?? new Error("upload_job_not_found");
  const typedJob = job as UploadJobRow;
  const { data: session, error: sessionError } = await db
    .from("upload_sessions")
    .select("id, user_id, user_email, purpose, destination, status")
    .eq("id", typedJob.session_id)
    .single();
  if (sessionError || !session) {
    throw sessionError ?? new Error("upload_session_not_found");
  }
  const typedSession = session as UploadSessionRow;
  const { data: fileRow, error: filesError } = await db
    .from("upload_session_files")
    .select("*")
    .eq("session_id", typedSession.id)
    .eq("id", typedJob.file_id)
    .single();
  if (filesError || !fileRow) {
    throw filesError ?? new Error("upload_session_file_not_found");
  }
  const file = fileRow as UploadFileRow;
  const terminalUploadFailure =
    file.status === "error" &&
    !!file.error_code &&
    TERMINAL_UPLOAD_ERROR_CODES.has(file.error_code);

  const startedAt = Date.now();
  const wallClockMs = uploadJobWallClockMs();
  const heartbeat: NodeJS.Timeout = setInterval(() => {
    // Past the wall-clock budget, stop renewing the lease. A wedged job then
    // ages out and claim_upload_processing_job can steal it for a retry
    // instead of the slot being held forever.
    if (Date.now() - startedAt >= wallClockMs) {
      clearInterval(heartbeat);
      return;
    }
    void heartbeatJob(db, jobId, workerId).catch((error) => {
      reportError(error, {
        level: "warning",
        tags: { component: "upload-worker", stage: "heartbeat" },
        extra: { job_id: jobId, worker_id: workerId },
      });
      console.error("[upload-worker] heartbeat failed", { jobId, error });
    });
  }, UPLOAD_WORKER_HEARTBEAT_MS);
  heartbeat.unref();

  let failed = false;
  let documentDeleted = false;
  try {
    if (file.status !== "completed" && !terminalUploadFailure) {
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
        failed = true;
        // A deleted destination is the one failure a retry makes WORSE.
        documentDeleted = error instanceof DeletedDocumentError;
        reportError(error, {
          tags: {
            component: "upload-worker",
            stage: "process-file",
            purpose: typedSession.purpose,
          },
          extra: {
            job_id: jobId,
            session_id: typedSession.id,
            file_id: file.id,
          },
        });
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
            error_code: documentDeleted
              ? "document_deleted"
              : "processing_failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", file.id)
          .eq("session_id", typedSession.id);
        if (updateError) throw updateError;
        if (error instanceof DeletedDocumentError) {
          // Durable, best-effort: these objects have no row pointing at them
          // any more, so this job is the last place that knows their keys.
          await enqueueStorageCleanup(db, error.orphanedKeys);
        }
        await markCreatedDocumentFailed(db, typedSession, file);
        await heartbeatJob(db, jobId, workerId);
      }

      if (!failed) {
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
        await deleteFileBestEffort(file.sealed_storage_path, "sealed-source-after-process");
        await heartbeatJob(db, jobId, workerId);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  const now = new Date().toISOString();
  // `documentDeleted` sits outside the attempt budget on purpose: retrying a
  // vanished destination cannot succeed, and the retry is exactly what put
  // the deleted document back.
  if (
    failed &&
    !documentDeleted &&
    typedJob.attempts < UPLOAD_JOB_MAX_ATTEMPTS
  ) {
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
    const { error: fileRetryError } = await db
      .from("upload_session_files")
      .update({
        status: "uploaded",
        error_code: null,
        updated_at: now,
      })
      .eq("id", typedJob.file_id)
      .eq("session_id", typedSession.id)
      .eq("status", "error")
      .eq("error_code", "processing_failed");
    if (fileRetryError) throw fileRetryError;
    await refreshUploadSessionStatus(db, typedSession.id);
    return;
  }

  const partialFailure = failed || terminalUploadFailure;
  if (partialFailure) {
    if (failed) await removeFailedCreatedDocument(db, typedSession, file);
    const { data: failedFiles } = await db
      .from("upload_session_files")
      .select("sealed_storage_path")
      .eq("session_id", typedSession.id)
      .eq("status", "error");
    for (const failedFile of failedFiles ?? []) {
      if (failedFile.sealed_storage_path) {
        await deleteFileBestEffort(failedFile.sealed_storage_path, "failed-file-sealed");
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
  await refreshUploadSessionStatus(db, typedSession.id);
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
    .select("id, session_id, file_id")
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
    const { error: fileError } = await db
      .from("upload_session_files")
      .update({
        status: "error",
        error_code: "processing_failed",
        updated_at: nowIso,
      })
      .eq("id", job.file_id)
      .eq("session_id", job.session_id)
      .eq("status", "processing");
    if (fileError) throw fileError;
    await refreshUploadSessionStatus(db, job.session_id);
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
      .select("status, staging_storage_path, sealed_storage_path")
      .eq("session_id", session.id);
    if (filesError) throw filesError;
    for (const file of files ?? []) {
      // A session can expire while an earlier file is already queued or being
      // processed. Never remove its sealed source out from under the worker.
      if (["uploaded", "processing", "completed"].includes(file.status)) {
        continue;
      }
      await Promise.all([
        file.staging_storage_path
          ? deleteFileBestEffort(file.staging_storage_path, "session-expiry")
          : Promise.resolve(),
        file.sealed_storage_path
          ? deleteFileBestEffort(file.sealed_storage_path, "session-expiry")
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

async function claimNextUploadJob(
  db: Db,
  workerId: string,
  maxRunningPerUser: number,
) {
  const { data, error } = await db.rpc("claim_upload_processing_job", {
    target_worker_id: workerId,
    target_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    target_max_running_per_user: maxRunningPerUser,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

function startUploadProcessingWorker(options: {
  maxRunningPerUser: number;
  runCleanup: boolean;
}) {
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
      if (options.runCleanup && Date.now() - lastCleanupAt >= 60_000) {
        await Promise.all([
          cleanupUploadSessions(db),
          cleanupUploadProcessingTempFiles(),
        ]);
        lastCleanupAt = Date.now();
      }
      const jobId = await claimNextUploadJob(
        db,
        workerId,
        options.maxRunningPerUser,
      );
      if (!jobId) {
        schedule(UPLOAD_WORKER_POLL_MS);
        return;
      }
      await processUploadJob(db, jobId, workerId);
      schedule(0);
    } catch (error) {
      // Nothing above this loop: an error here means claiming or the job
      // wrapper itself broke, and without a report the worker just polls on.
      reportError(error, {
        tags: { component: "upload-worker", stage: "iteration" },
        extra: { worker_id: workerId },
      });
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

export function startUploadProcessingWorkers(options: {
  concurrency: number;
  maxRunningPerUser: number;
}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const maxRunningPerUser = Math.max(
    1,
    Math.min(concurrency, Math.floor(options.maxRunningPerUser)),
  );
  const stopWorkers = Array.from({ length: concurrency }, (_, index) =>
    startUploadProcessingWorker({
      maxRunningPerUser,
      runCleanup: index === 0,
    }),
  );

  return () => {
    for (const stopWorker of stopWorkers) stopWorker();
  };
}
