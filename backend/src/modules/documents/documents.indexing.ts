import { createHash } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { EXTRACTION_MAX_BYTES, ExtractionLimitError, ExtractionBusyError, withBackgroundExtraction } from "../../lib/extraction/isolated";
import { DbJobDeferredError, type Db, type DbJob } from "../../lib/dbq/types";
import { AppError } from "../../lib/appError";
import { reportError, setOperation } from "../../lib/observability/sentry";

export { extractDocumentText } from "../../lib/extraction/documentText";

/** Extract and publish only while the queued version revision still matches. */
export async function handleDocumentExtractText(db: Db, job: DbJob): Promise<void> {
  setOperation("documents.extract");
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  try {
    await withBackgroundExtraction({ waitMs: job.status === "running" ? 60_000 : undefined }, async (extract) => {
      const { data: version, error } = await db.from("document_versions")
        .select("id,storage_path,file_type,filename,content_sha256,text_revision,size_bytes")
        .eq("id", versionId).eq("text_revision", revision).is("deleted_at", null).maybeSingle();
      if (error) throw error;
      if (!version?.storage_path) return; // superseded/deleted work is a successful no-op
      const fileType = version.file_type || version.filename?.split(".").pop() || "";
      // Retrying cannot shrink the file, so too large is final, not a retry.
      if ((version.size_bytes ?? 0) > EXTRACTION_MAX_BYTES) {
        await markDocumentTextFailed(db, job, "too_large");
        return;
      }
      const { data: claim, error: claimError } = await db.from("document_version_texts")
        .update({ status: "processing", error_code: null, updated_at: new Date().toISOString() })
        .eq("version_id", versionId).eq("source_revision", revision)
        .in("status", ["pending", "processing", "failed"]).select("version_id").maybeSingle();
      if (claimError) throw claimError;
      if (!claim) return; // already published, replaced, or deleted
      const raw = await downloadFile(version.storage_path);
      if (!raw) throw new Error("document_text_source_unavailable");
      const hash = createHash("sha256").update(Buffer.from(raw)).digest("hex");
      if (version.content_sha256 && version.content_sha256 !== hash) throw new Error("document_text_source_changed");
      let extracted: { text: string; textlessPageCount: number | null };
      try {
        extracted = await extract("documentText", raw, { fileType });
      } catch (err) {
        if (!(err instanceof ExtractionLimitError)) throw err;
        await markDocumentTextFailed(db, job, "too_large");
        return;
      }
      const { text, textlessPageCount } = extracted;
      const { error: publishError } = await db.rpc("publish_document_text", {
        p_version_id: versionId, p_revision: revision,
        // PostgreSQL text cannot contain NUL; do not truncate otherwise.
        p_text: text.replaceAll("\0", ""), p_sha256: hash, p_textless_pages: textlessPageCount,
      });
      if (publishError) throw publishError;
    });
  } catch (error) {
    if (error instanceof ExtractionBusyError) {
      // Existing DB-queue deferral refunds the claim attempt and preserves its fence.
      throw new DbJobDeferredError(new Date(Date.now() + 30_000).toISOString(), "document_extraction_busy");
    }
    throw error;
  }
}

/** Mark exhausted work failed without overwriting a newer revision or ready text. */
export async function markDocumentTextFailed(db: Db, job: DbJob, errorCode = "extraction_failed"): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  const { error } = await db.from("document_version_texts")
    .update({ status: "failed", text_content: null, error_code: errorCode, updated_at: new Date().toISOString() })
    .eq("version_id", versionId).eq("source_revision", revision).in("status", ["pending", "processing", "failed"]);
  if (error) throw error;
}

/** Escape-hatch deployments still process durable text work without a runner. */
export async function processDocumentTextInline(db: Db, versionIds?: string[]) {
  if (process.env.DB_JOBS_ENABLED !== "false") return;
  let query = db.from("db_jobs").select("*").eq("kind", "document.extract_text").eq("status", "pending");
  if (versionIds?.length) query = query.in("payload->>versionId", versionIds);
  const { data, error } = await query.order("created_at").limit(versionIds?.length ?? 5);
  if (error) throw error;
  for (const job of (data ?? []) as DbJob[]) {
    try {
      await handleDocumentExtractText(db, job);
      const { error: doneError } = await db.from("db_jobs").update({ status: "done", finished_at: new Date().toISOString() })
        .eq("id", job.id).eq("status", "pending");
      if (doneError) throw doneError;
    } catch (err) {
      await markDocumentTextFailed(db, job);
      const { error: failedError } = await db.from("db_jobs").update({ status: "failed", last_error: "extraction_failed", finished_at: new Date().toISOString() })
        .eq("id", job.id).eq("status", "pending");
      if (failedError) throw failedError;
      // No runner reports this path: name the job and the kind here, keep the
      // real error as the cause (its code reaches failure_code), and log the
      // same object so the console bridge files no second event.
      const failure = err instanceof AppError
        ? err
        : new AppError("extraction.failed", "document text extraction failed", { cause: err });
      reportError(failure, {
        tags: { job_kind: "document.extract_text" },
        extra: { job_id: job.id },
      });
      console.error("[document-text-inline] extraction failed", failure);
    }
  }
}

/** Queue a bounded, resumable batch of missing text, optionally retrying failures. */
export async function backfillDocumentText(db: Db, options: { limit?: number; retryFailed?: boolean } = {}) {
  const { data, error } = await db.rpc("backfill_document_text", {
    p_limit: options.limit ?? 100, p_retry_failed: options.retryFailed ?? false,
  });
  if (error) throw error;
  await processDocumentTextInline(db);
  return Number(data ?? 0);
}
