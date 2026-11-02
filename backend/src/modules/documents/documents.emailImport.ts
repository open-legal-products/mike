import type { Db } from "../../lib/supabase";
import { processDocumentTextInline } from "./documents.indexing";
import { logError } from "../../lib/log";
import { safeError } from "../../lib/safeError";

/** Caller authorizes preview, destination and connector. The transaction
 * rechecks these and atomically activates the version with its intake receipt. */
export async function commitEmailDocument(db: Db, itemId: string, leaseId: string, previewId: string, version: Record<string, unknown>) {
  const result = await db.rpc("commit_project_email_document", { p_item_id: itemId, p_lease: leaseId, p_preview_id: previewId, p_version: version });
  if (!result.error && result.data?.version_id) {
    await processDocumentTextInline(db, [result.data.version_id]).catch(error => logError("document-text", safeError(error)));
  }
  return result;
}
