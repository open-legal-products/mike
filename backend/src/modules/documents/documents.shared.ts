// Shared types and helpers for the documents module's service files.
// Everything public here is re-exported through documents.service.ts,
// which remains the module's stable facade.

import { createServerSupabase } from "../../lib/supabase";
import { extractedTextKey } from "../../lib/storage";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";

export type Db = ReturnType<typeof createServerSupabase>;

// pdfjs page counting is shared with the projects module — the single
// implementation lives in lib/pdfjs.ts alongside the loader it uses.
export { countPdfPages } from "../../lib/pdfjs";

// Structural slice of Express.Multer.File — only these two fields are read.
export type UploadedFile = { buffer: Buffer; originalname: string };

export async function deleteDocumentAndVersionFiles(
    db: Db,
    documentId: string,
) {
    // Storage lives on document_versions — collect every version's bytes
    // (source + PDF rendition), drop the document row, then hand the object
    // deletes to the durable storage.cleanup job. Previously each delete was
    // fire-and-forget (`.catch(() => {})`): one storage hiccup silently leaked
    // the files forever. Rows first, files second — if the row delete fails
    // nothing has been touched and the document stays intact; if the process
    // dies after it, the queued job still removes the files.
    const { data: versions } = await db
        .from("document_versions")
        .select("id, storage_path, pdf_storage_path")
        .eq("document_id", documentId);
    const keys = (versions ?? []).flatMap((v) =>
        // The extracted-text cache is keyed by version id and sits outside the
        // per-user prefixes, so this is the only place that can reach it.
        // Deleting an object that was never written is a no-op, hence no gate.
        [
            v.storage_path,
            v.pdf_storage_path,
            typeof v.id === "string" && v.id ? extractedTextKey(v.id) : null,
        ].filter((p): p is string => typeof p === "string" && p.length > 0),
    );
    const result = await db.from("documents").delete().eq("id", documentId);
    if (!result.error) await enqueueStorageCleanup(db, keys);
    return result;
}

// Produce the filename a download should present to the user. The helper now
// lives in lib/documentVersions (the "documents-zip" export job names its zip
// entries with it too); re-exported here so this module's importers keep the
// same surface.
export { downloadFilenameForVersion } from "../../lib/documentVersions";
