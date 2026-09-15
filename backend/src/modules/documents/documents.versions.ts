import {
    captureInlineDocumentCleanup,
    completeInlineDocumentCleanup,
} from "./documents.cleanupJobs";
import { copyDocumentVersionFiles } from "./documents.copyFiles";
import { createDocumentVersion } from "./documents.lifecycle";
// Version lifecycle for documents: listing, creating one from another
// document's bytes, renaming, and deleting versions.
//
// Uploading bytes is NOT here: browser clients create versions through the
// direct object-storage upload-session protocol (modules/uploads), and the
// former multipart endpoints answer 410.

import {
    downloadFile,
    uploadFile,
    versionStorageKey,
} from "../../lib/storage";
import { docxToPdf } from "../../lib/convert";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { creatorScopedAllowed } from "../../lib/access";
import { can } from "../../lib/permissions";
import {
    documentSuffix,
    shouldConvertToPdf,
} from "../../lib/documentTypes";
import { deleteDocumentAndVersionFiles, type Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";

// ---------------------------------------------------------------------------
// Versions list
// ---------------------------------------------------------------------------

export async function listVersions(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<
    | { ok: true; current_version_id: string | null; versions: unknown[] }
    | { ok: false; detail: string }
> {
    const access = await ensureDocumentAccess(
        documentId,
        userId,
        userEmail,
        db,
        {
            select: "id, current_version_id, user_id, project_id, workflow_id",
        },
    );
    if (!access.ok) return { ok: false, detail: "Document not found" };

    const { data: rows } = await db
        .from("document_versions")
        .select(
            "id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at, deleted_by",
        )
        .eq("document_id", documentId)
        .order("created_at", { ascending: true });

    return {
        ok: true,
        current_version_id: access.doc.current_version_id ?? null,
        versions: rows ?? [],
    };
}

// ---------------------------------------------------------------------------
// Create version from another document
// ---------------------------------------------------------------------------

export async function createVersionFromDocument(
    params: {
        documentId: string;
        sourceDocumentId: string;
        requestedFilename: string | null;
        userId: string;
        userEmail: string | undefined;
    },
    db: Db,
): Promise<
    | { ok: true; version: unknown }
    | {
          ok: false;
          kind:
              | "target_not_found"
              | "source_not_found"
              | "source_not_owner"
              | "source_no_active"
              | "source_bytes"
              | "storage_write"
              | "version_insert"
              | "doc_update"
              | "source_delete";
          detail: string;
      }
> {
    const {
        documentId,
        sourceDocumentId,
        requestedFilename,
        userId,
        userEmail,
    } = params;

    const targetAccess = await ensureDocumentAccess(
        documentId,
        userId,
        userEmail,
        db,
    );
    // Adding a version mutates the target, so read access is not enough:
    // a viewer-only workflow share must not be able to write into it.
    if (!targetAccess.ok || !can(targetAccess.projectRole, "content.edit"))
        return {
            ok: false,
            kind: "target_not_found",
            detail: "Document not found",
        };
    const targetDoc = targetAccess.doc;

    const sourceAccess = await ensureDocumentAccess(
        sourceDocumentId,
        userId,
        userEmail,
        db,
    );
    if (!sourceAccess.ok)
        return {
            ok: false,
            kind: "source_not_found",
            detail: "Source document not found",
        };
    const sourceDoc = sourceAccess.doc;
    const willDeleteSource =
        (sourceDoc.project_id &&
            targetDoc.project_id &&
            sourceDoc.project_id === targetDoc.project_id) ||
        (!sourceDoc.project_id &&
            !targetDoc.project_id &&
            sourceDoc.user_id === userId &&
            targetDoc.user_id === userId);
    if (
        willDeleteSource &&
        !creatorScopedAllowed(sourceAccess, sourceDoc.user_id)
    ) {
        return {
            ok: false,
            kind: "source_not_owner",
            detail: "Only the source document's creator can move it into a version.",
        };
    }

    const active = await loadActiveVersion(sourceDocumentId, db);
    if (!active)
        return {
            ok: false,
            kind: "source_no_active",
            detail: "Source document has no active version.",
        };
    const sourceType = active.file_type ?? "";

    const bytes = await downloadFile(active.storage_path);
    if (!bytes)
        return {
            ok: false,
            kind: "source_bytes",
            detail: "Source document bytes not available.",
        };

    const filename =
        requestedFilename && requestedFilename.trim()
            ? requestedFilename.trim().slice(0, 200)
            : active.filename?.trim() || "Untitled document";
    const suffix = sourceType || documentSuffix(filename);
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, filename);
    let pdfStoragePath: string | null = null;

    try {
        ({ pdfStoragePath } = await copyDocumentVersionFiles({
            source: { ...active, file_type: suffix },
            storagePath: key,
            pdfStoragePath: `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
            transport: "download",
            rendition: "optional",
            sourceBytes: bytes,
        }));
    } catch (e) {
        console.error("[versions/copy] storage write failed", e);
        return {
            ok: false,
            kind: "storage_write",
            detail: "Failed to create new version.",
        };
    }

    let deferConversion = false;
    if (suffix === "pdf") {
        pdfStoragePath = key;
    } else if (!active.pdf_storage_path && shouldConvertToPdf(suffix)) {
        // Only reached when the source has no rendition to copy — this is the
        // one branch of the copy flow that pays for LibreOffice, so it's the
        // branch the conversion queue takes over when the flag is on.
        if (process.env.ASYNC_DOCUMENT_CONVERSION === "true") {
            deferConversion = true;
        } else {
            try {
                const pdfBuf = await docxToPdf(Buffer.from(bytes));
                const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
                await uploadFile(
                    pdfKey,
                    pdfBuf.buffer.slice(
                        pdfBuf.byteOffset,
                        pdfBuf.byteOffset + pdfBuf.byteLength,
                    ) as ArrayBuffer,
                    "application/pdf",
                );
                pdfStoragePath = pdfKey;
            } catch (err) {
                console.error(
                    "[versions/copy] Office→PDF conversion failed",
                    { filename },
                    err,
                );
            }
        }
    }

    const { data: versionRow, error: verErr } = await createDocumentVersion(
        db,
        {
            document_id: documentId,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
            source: "user_upload",

            filename: filename,
            file_type: sourceType || null,
            size_bytes: active.size_bytes ?? bytes.byteLength,
            page_count: active.page_count,
            content_sha256: contentSha256(bytes),
        },
    );
    if (verErr || !versionRow) {
        console.error("[versions/copy] insert failed", verErr);
        return {
            ok: false,
            kind: "version_insert",
            detail: "Failed to record new version.",
        };
    }

    if (deferConversion) {
        await enqueueConversion({
            documentId,
            versionId: versionRow.id as string,
            userId,
            storagePath: key,
            fileType: suffix,
            pdfKey: `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
            finalizeDocumentStatus: false,
        });
    }

    if (willDeleteSource) {
        const { error: deleteErr } = await deleteDocumentAndVersionFiles(
            db,
            sourceDocumentId,
        );
        if (deleteErr) {
            console.error(
                "[versions/copy] source document delete failed",
                deleteErr,
            );
            return {
                ok: false,
                kind: "source_delete",
                detail: "Failed to delete source document.",
            };
        }
    }

    const {
        id,
        version_number,
        source,
        created_at,
        filename: savedFilename,
    } = versionRow;
    return {
        ok: true,
        version: {
            id,
            version_number,
            source,
            created_at,
            filename: savedFilename,
        },
    };
}

// ---------------------------------------------------------------------------
// Rename a version
// ---------------------------------------------------------------------------

export async function renameVersion(
    params: {
        documentId: string;
        versionId: string;
        rawFilename: unknown;
        userId: string;
        userEmail: string | undefined;
    },
    db: Db,
): Promise<{ ok: true; version: unknown } | { ok: false; detail: string }> {
    const { documentId, versionId, rawFilename, userId, userEmail } = params;

    const access = await ensureDocumentAccess(
        documentId,
        userId,
        userEmail,
        db,
    );
    // A rename is a write: viewer-only shares are rejected the same way a
    // missing document is.
    if (!access.ok || !can(access.projectRole, "content.edit"))
        return { ok: false, detail: "Document not found" };

    const filename =
        typeof rawFilename === "string" && rawFilename.trim()
            ? rawFilename.trim().slice(0, 200)
            : null;

    const { data: updated, error } = await db
        .from("document_versions")
        .update({ filename })
        .eq("id", versionId)
        .eq("document_id", documentId)
        .is("deleted_at", null)
        .select(
            "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
        )
        .single();
    if (error || !updated) {
        return { ok: false, detail: "Version not found" };
    }
    return { ok: true, version: updated };
}

// ---------------------------------------------------------------------------
// Delete a version
// ---------------------------------------------------------------------------

export async function deleteVersion(
    documentId: string,
    versionId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | {
          ok: false;
          kind: "doc_not_found" | "version_not_found" | "only_version";
          detail: string;
      }
    // Every DB failure on this path is an opaque internal error — the route
    // hands the raw error to sendInternalError rather than echoing it.
    | { ok: false; kind: "db"; error: unknown }
> {
    const access = await ensureDocumentAccess(
        documentId,
        userId,
        userEmail,
        db,
        {
            select: "id, user_id, project_id, org_id, workflow_id, current_version_id",
        },
    );
    // Deleting a version is creator-scoped (with the admin heir once the
    // creator's account is gone). Workflow documents are the exception: an
    // editor on the workflow share manages its versions too.
    if (
        !access.ok ||
        (!creatorScopedAllowed(access, access.doc.user_id) &&
            !(
                access.doc.workflow_id &&
                can(access.projectRole, "content.edit")
            ))
    )
        return {
            ok: false,
            kind: "doc_not_found",
            detail: "Document not found",
        };
    const keys = await captureInlineDocumentCleanup(db, {
        versionIds: [versionId],
    });
    const { data, error } = await db.rpc("delete_document_version", {
        p_document_id: documentId,
        p_version_id: versionId,
        p_actor_id: userId,
    });
    if (error) return { ok: false, kind: "db", error };
    if (data?.kind === "only_version")
        return {
            ok: false,
            kind: "only_version",
            detail: "Cannot delete the only document version.",
        };
    if (data?.kind === "doc_not_found")
        return {
            ok: false,
            kind: "doc_not_found",
            detail: "Document not found",
        };
    if (data?.kind === "version_not_found")
        return {
            ok: false,
            kind: "version_not_found",
            detail: "Version not found",
        };
    if (!data?.deleted_version_id)
        return {
            ok: false,
            kind: "db",
            error: new Error("version_delete_returned_no_data"),
        };
    await completeInlineDocumentCleanup(db, keys);
    return { ok: true, payload: data };
}
