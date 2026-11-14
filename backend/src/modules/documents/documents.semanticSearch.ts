import type { Db } from "../../lib/supabase";
import { AppError } from "../../lib/appError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import {
  embedQuery,
  readEmbeddingConfig,
  toVectorLiteral,
  type EmbeddingConfig,
} from "../../lib/rag/embeddingClient";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DocumentChunkMatch = {
  document_id: string; version_id: string; version_number: number | null;
  revision: string; filename: string; file_type: string; storage_path: string;
  library_kind: string; chunk_index: number; page_start: number | null; page_end: number | null;
  start_char: number; end_char: number; excerpt: string;
  score: number; vector_rank: number | null; lexical_rank: number | null;
};

export type DocumentSemanticSearch = {
  matches: DocumentChunkMatch[];
  coverage: { total_versions: number; embedded_versions: number };
};

/**
 * Hybrid (vector + full-text, Reciprocal Rank Fusion) search over the chunk
 * index of the caller's eligible current versions. Same scopes and access
 * rules as findDocumentText; the query is embedded with the deployment's
 * configured provider.
 */
export async function searchDocumentsSemantic(db: Db, args: {
  userId: string; userEmail?: string | null; workspace?: string | null;
  scope: string; query: string; projectId?: string | null; documentId?: string | null;
  limit?: number;
}, cfg: EmbeddingConfig = readEmbeddingConfig(), fetchImpl: typeof fetch = fetch,
): Promise<ServiceResult<DocumentSemanticSearch>> {
  if (!cfg.enabled) {
    return failure("unavailable", "Semantic search is not configured on this server. Use find_documents instead.");
  }
  const limit = args.limit ?? 8;
  if (!["project", "library", "templates", "document"].includes(args.scope)
    || typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 2000
    || !Number.isInteger(limit) || limit < 1 || limit > 20
    || (args.scope === "project" && !args.projectId)
    || (args.scope === "document" && !args.documentId)
    || [args.projectId, args.documentId].some((id) => id != null && !UUID.test(id))) {
    return failure("validation", "Choose a scope and a question of 2–2000 characters, with a limit of 1–20.");
  }
  let vector: number[];
  try {
    vector = await embedQuery(args.query, cfg, fetchImpl);
  } catch (cause) {
    return internalFailure(cause instanceof AppError
      ? cause
      : new AppError("rag.embedding_failed", "Query embedding failed", { cause }));
  }
  const { data, error } = await db.rpc("search_document_chunks", {
    p_user_id: args.userId, p_user_email: args.userEmail ?? null,
    p_workspace: args.workspace ?? "personal", p_scope: args.scope,
    p_query_text: args.query, p_query_embedding: toVectorLiteral(vector), p_model: cfg.indexKey,
    p_project_id: args.projectId ?? null, p_document_id: args.documentId ?? null, p_limit: limit,
  });
  if (error) return internalFailure(new AppError("rag.search_failed", "Semantic search failed", { cause: error }));
  const result = (data ?? {}) as Partial<DocumentSemanticSearch>;
  return ok({
    matches: Array.isArray(result.matches) ? result.matches : [],
    coverage: {
      total_versions: Number(result.coverage?.total_versions ?? 0),
      embedded_versions: Number(result.coverage?.embedded_versions ?? 0),
    },
  });
}
