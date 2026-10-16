import { createHash } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPdfTextForIndex } from "../../lib/pdfText";
import { docxToPdf } from "../../lib/convert";
import { extractPresentationText } from "../../lib/officeText";
import { spreadsheetToLLMText } from "../../lib/spreadsheet";
import { isSpreadsheetDocumentType, requiresLibreOfficeTextExtraction } from "../../lib/documentTypes";
import type { Db, DbJob } from "../../lib/dbq/types";
import { safeError } from "../../lib/safeError";
import { logError } from "../../lib/log";

/** Complete text, using the same accepted DOCX view as the edit matcher. */
export async function extractDocumentText(raw: ArrayBuffer, fileType: string) {
  const type = fileType.toLowerCase();
  if (type === "pdf") return extractPdfTextForIndex(raw);
  if (requiresLibreOfficeTextExtraction(type)) {
    const pdf = await docxToPdf(Buffer.from(raw));
    return extractPdfTextForIndex(Uint8Array.from(pdf).buffer);
  }
  let text: string;
  if (type === "docx") {
    text = await extractDocxBodyText(Buffer.from(raw));
    if (!text) text = (await (await import("mammoth")).extractRawText({ buffer: Buffer.from(raw) })).value;
  } else if (isSpreadsheetDocumentType(type)) {
    text = spreadsheetToLLMText(Buffer.from(raw));
  } else if (type === "pptx") {
    text = await extractPresentationText(Buffer.from(raw));
  } else {
    throw new Error("document_text_unsupported_format");
  }
  return { text, textlessPageCount: null };
}

/** Extract and publish only while the queued version revision still matches. */
export async function handleDocumentExtractText(db: Db, job: DbJob): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  const { data: version, error } = await db.from("document_versions")
    .select("id,storage_path,file_type,filename,content_sha256,text_revision")
    .eq("id", versionId).eq("text_revision", revision).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!version?.storage_path) return; // superseded/deleted work is a successful no-op
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
  const { text, textlessPageCount } = await extractDocumentText(raw,
    version.file_type || version.filename?.split(".").pop() || "");
  const { error: publishError } = await db.rpc("publish_document_text", {
    p_version_id: versionId, p_revision: revision,
    // PostgreSQL text cannot contain NUL; do not truncate otherwise.
    p_text: text.replaceAll("\0", ""), p_sha256: hash, p_textless_pages: textlessPageCount,
  });
  if (publishError) throw publishError;
}

/** Mark exhausted work failed without overwriting a newer revision or ready text. */
export async function markDocumentTextFailed(db: Db, job: DbJob): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  const { error } = await db.from("document_version_texts")
    .update({ status: "failed", text_content: null, error_code: "extraction_failed", updated_at: new Date().toISOString() })
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
      logError("document-text-inline", safeError(err));
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
