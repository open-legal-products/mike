import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "./documents.cleanupJobs";
// Shared types and helpers for the documents module's service files.
// Everything public here is re-exported through documents.service.ts,
// which remains the module's stable facade.

import type { Db } from "../../lib/supabase";
export type { Db };
/** Trusted internal delete: callers must establish document access first.
 * Cascading version triggers capture all cleanup keys before rows disappear. */
export async function deleteDocumentAndVersionFiles(db: Db, documentId: string) {
    const keys = await captureInlineDocumentCleanup(db, { documentIds: [documentId] });
    const result = await db.from("documents").delete().eq("id", documentId);
    if (!result.error) await completeInlineDocumentCleanup(db, keys);
    return result;
}

// Produce the filename a download should present to the user. The helper now
// lives in lib/documentVersions (the "documents-zip" export job names its zip
// entries with it too); re-exported here so this module's importers keep the
// same surface.
export { downloadFilenameForVersion } from "../../lib/documentVersions";
