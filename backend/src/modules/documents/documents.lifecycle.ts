import {
  captureInlineVersionUpdateCleanup,
  completeInlineDocumentCleanup,
} from "./documents.cleanupJobs";
import { type Db } from "../../lib/supabase";

export type NewDocumentVersion = {
  id?: string;
  document_id: string;
  storage_path: string;
  pdf_storage_path?: string | null;
  source: string;
  version_number?: number | null;
  filename: string;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  content_sha256?: string | null;
};

export type DocumentVersionRecord = NewDocumentVersion & {
  id: string;
  version_number: number;
  created_at: string;
  deleted_at: string | null;
};

/**
 * Trusted persistence operation. The caller must authorize the destination
 * (and independently authorize any copy source). Upload workers use their
 * validated session destination; chat tools use their authorized document
 * store. Number allocation, insertion and activation share one transaction.
 * A stable id makes retries idempotent without overwriting newer work.
 */
export async function createDocumentVersion(
  db: Db,
  version: NewDocumentVersion,
  options: { activate?: boolean } = {},
) {
  const { document_id, ...metadata } = version;
  const { data, error } = await db.rpc("create_document_version", {
    p_document_id: document_id,
    p_version: metadata,
    p_activate: options.activate !== false,
  });
  return { data: data as DocumentVersionRecord | null, error };
}

/** All versions and active pointers commit together, or none do. */
export async function createDocumentVersions(
  db: Db,
  versions: NewDocumentVersion[],
) {
  const { data, error } = await db.rpc("create_document_versions", {
    p_versions: versions,
  });
  return { data: data as DocumentVersionRecord[] | null, error };
}

/** Call after dependent edit rows are persisted. Reject stale/deleted targets. */
export async function activateDocumentVersion(
  db: Db,
  documentId: string,
  versionId: string,
) {
  const { data, error } = await db.rpc("activate_document_version", {
    p_document_id: documentId,
    p_version_id: versionId,
  });
  return { activated: data === true, error };
}

export type DocumentVersionPatch = Partial<
  Omit<NewDocumentVersion, "id" | "document_id" | "source" | "version_number">
> & {
  content_sha256?: string | null;
  created_at?: string;
};

/** Only live versions within the authorized document can be replaced. */
export async function updateDocumentVersion(
  db: Db,
  documentId: string,
  versionId: string,
  patch: DocumentVersionPatch,
) {
  const keys = await captureInlineVersionUpdateCleanup(
    db,
    documentId,
    versionId,
    patch,
  );
  const result = await db
    .from("document_versions")
    .update(patch)
    .eq("id", versionId)
    .eq("document_id", documentId)
    .is("deleted_at", null)
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
    )
    .maybeSingle();
  if (!result.error && result.data)
    await completeInlineDocumentCleanup(db, keys);
  return result;
}
