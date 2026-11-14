import { AppError } from "../../lib/appError";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import type { Db, DbJob } from "../../lib/dbq/types";
import { reportError, setOperation } from "../../lib/observability/sentry";
import { chunkDocumentText } from "../../lib/rag/chunking";
import {
  embedDocuments,
  readEmbeddingConfig,
  toVectorLiteral,
  type EmbeddingConfig,
} from "../../lib/rag/embeddingClient";

/**
 * document.embed_text: chunk the published text of one version revision,
 * embed the chunks with the configured provider and atomically replace the
 * version's chunk index for that model. Revision-bound like extraction: a job
 * for an edited, deleted or re-modelled version is a successful no-op.
 */
export async function handleDocumentEmbedText(
  db: Db,
  job: DbJob,
  cfg: EmbeddingConfig = readEmbeddingConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  setOperation("documents.embed");
  const { versionId, revision, model } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || typeof model !== "string") return;
  // RAG off or embedding space changed since queueing: leave the row pending;
  // backfill_document_embeddings requeues pending rows that have no live job.
  if (!cfg.enabled || cfg.indexKey !== model) return;

  const { data: claim, error: claimError } = await db.from("document_embedding_status")
    .update({ status: "processing", error_code: null, updated_at: new Date().toISOString() })
    .eq("version_id", versionId).eq("embedding_model", model).eq("source_revision", revision)
    .in("status", ["pending", "processing", "failed"]).select("version_id").maybeSingle();
  if (claimError) throw claimError;
  if (!claim) return;

  const { data: text, error: textError } = await db.from("document_version_texts")
    .select("text_content")
    .eq("version_id", versionId).eq("source_revision", revision).eq("status", "ready")
    .maybeSingle();
  if (textError) throw textError;
  if (!text || typeof text.text_content !== "string") return; // superseded text

  const chunks = chunkDocumentText(text.text_content, {
    chunkChars: cfg.chunkChars,
    overlap: cfg.chunkOverlap,
    maxChunks: cfg.maxChunksPerVersion + 1,
  });
  if (chunks.length > cfg.maxChunksPerVersion) {
    await markDocumentEmbeddingsFailed(db, job, "too_large");
    return;
  }

  let vectors: number[][];
  try {
    vectors = chunks.length ? await embedDocuments(chunks.map((c) => c.content), cfg, fetchImpl) : [];
  } catch (cause) {
    const failure = cause instanceof AppError
      ? cause
      : new AppError("rag.embedding_failed", "Document embedding failed", { cause });
    // A 4xx (bad key, unknown model, input too long) fails the same way on
    // every attempt; everything else keeps the queue's retries.
    const status = (failure.cause as { status?: number } | undefined)?.status;
    if (failure.kind === "rag.embedding_http_failed" && status && status >= 400 && status < 500 && status !== 429) {
      throw new NonRetryableJobError("document_embedding_rejected", { cause: failure, reportLevel: "warning" });
    }
    throw failure;
  }

  const payload = chunks.map((c, i) => ({
    chunk_index: c.chunkIndex,
    page_start: c.pageStart,
    page_end: c.pageEnd,
    start_char: c.startChar,
    end_char: c.endChar,
    content: c.content.replaceAll("\0", ""),
    embedding: toVectorLiteral(vectors[i]!),
  }));
  const { error: replaceError } = await db.rpc("replace_document_text_chunks", {
    p_version_id: versionId, p_revision: revision, p_model: model, p_chunks: payload,
  });
  if (replaceError) throw replaceError;
}

/** Failure hook: mark exhausted embedding work failed for its exact revision/model. */
export async function markDocumentEmbeddingsFailed(db: Db, job: DbJob, errorCode = "embedding_failed"): Promise<void> {
  const { versionId, revision, model } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || typeof model !== "string") return;
  const { error } = await db.from("document_embedding_status")
    .update({ status: "failed", error_code: errorCode, updated_at: new Date().toISOString() })
    .eq("version_id", versionId).eq("embedding_model", model).eq("source_revision", revision)
    .in("status", ["pending", "processing", "failed"]);
  if (error) throw error;
}

/**
 * Queue embeddings for a freshly published version. Best effort: a failure is
 * a warning, never a reason to fail text extraction; the backfill recovers it.
 */
export async function queueDocumentEmbeddings(
  db: Db,
  versionId: string,
  cfg: EmbeddingConfig = readEmbeddingConfig(),
): Promise<void> {
  if (!cfg.enabled) return;
  const { error } = await db.rpc("queue_document_embeddings", { p_version_id: versionId, p_model: cfg.indexKey });
  if (error) {
    reportError(new AppError("rag.queue_failed", "Embedding job could not be queued", { cause: error }), {
      level: "warning",
      tags: { component: "documents", stage: "embed-queue", job_kind: "document.embed_text" },
    });
  }
}

/** Queue a bounded batch of versions that have ready text but no current embeddings. */
export async function backfillDocumentEmbeddings(
  db: Db,
  options: { limit?: number; retryFailed?: boolean } = {},
  cfg: EmbeddingConfig = readEmbeddingConfig(),
): Promise<number> {
  if (!cfg.enabled) return 0;
  const { data, error } = await db.rpc("backfill_document_embeddings", {
    p_model: cfg.indexKey, p_limit: options.limit ?? 100, p_retry_failed: options.retryFailed ?? false,
  });
  if (error) throw error;
  return Number(data ?? 0);
}
