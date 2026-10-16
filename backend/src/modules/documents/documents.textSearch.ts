import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DocumentTextMatch = {
  document_id: string; version_id: string; version_number: number | null;
  revision: string; filename: string; file_type: string; storage_path: string;
  library_kind: string; start_char: number; end_char: number;
  excerpt_start_char: number; excerpt: string;
};
export type DocumentTextSearch = {
  matches: DocumentTextMatch[];
  next_offset: number | null;
  coverage: {
    total_versions: number; indexed_versions: number; pending_versions: number;
    failed_versions: number; versions_needing_ocr: number;
  };
};

/** Validate search bounds and query only text visible to the server-supplied actor. */
export async function findDocumentText(db: Db, args: {
  userId: string; userEmail?: string | null; workspace?: string | null;
  scope: string; query: string; projectId?: string | null;
  documentId?: string | null; versionId?: string | null;
  limit?: number; offset?: number;
}): Promise<ServiceResult<DocumentTextSearch>> {
  const limit = args.limit ?? 10;
  const offset = args.offset ?? 0;
  if (!["project", "library", "templates", "document"].includes(args.scope)
    || typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 500
    || !Number.isInteger(limit) || limit < 1 || limit > 20
    || !Number.isInteger(offset) || offset < 0 || offset > 100000
    || (args.scope === "project" && !args.projectId)
    || (args.scope === "document" && !args.documentId)
    || (args.versionId && args.scope !== "document")
    || [args.projectId, args.documentId, args.versionId].some((id) => id != null && !UUID.test(id))) {
    return failure("validation", "Choose a scope and a phrase of 2–500 characters, with a limit of 1–20.");
  }
  const { data, error } = await db.rpc("find_document_text", {
    p_user_id: args.userId, p_user_email: args.userEmail ?? null,
    p_workspace: args.workspace ?? "personal", p_scope: args.scope, p_query: args.query,
    p_project_id: args.projectId ?? null, p_document_id: args.documentId ?? null,
    p_version_id: args.versionId ?? null, p_limit: limit, p_offset: offset,
  });
  if (error) return internalFailure(error);
  return ok(data as DocumentTextSearch);
}

export type StoredDocumentText = {
  revision: string; status: "pending" | "processing" | "ready" | "failed";
  text: string | null; textless_page_count: number | null;
};
/** Rechecks authorization and matches the version to its parent in the same query. */
export async function readStoredDocumentText(db: Db, args: {
  userId: string; userEmail?: string | null; documentId: string; versionId: string;
}): Promise<StoredDocumentText | null> {
  const { data, error } = await db.rpc("read_document_text", {
    p_user_id: args.userId, p_user_email: args.userEmail ?? null,
    p_document_id: args.documentId, p_version_id: args.versionId,
  });
  if (error) throw error;
  return data as StoredDocumentText | null;
}
