// Version lifecycle for documents: listing, creating (from another document
// or an uploaded file), renaming, replacing bytes, and deleting versions.

import {
    downloadFile,
    deleteFile,
    uploadFile,
    versionStorageKey,
} from "../../lib/storage";
import { docxToPdf } from "../../lib/convert";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import {
    contentTypeForDocumentType,
    documentSuffix,
    shouldConvertToPdf,
} from "../../lib/documentTypes";
import {
    countPdfPages,
    deleteDocumentAndVersionFiles,
    type Db,
    type UploadedFile,
} from "./documents.shared";
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
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db, {
        select: "id, current_version_id, user_id, project_id",
    });
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
    const { documentId, sourceDocumentId, requestedFilename, userId, userEmail } =
        params;

    const targetAccess = await ensureDocumentAccess(
        documentId,
        userId,
        userEmail,
        db,
    );
    if (!targetAccess.ok)
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
    if (willDeleteSource && !sourceAccess.isOwner) {
        return {
            ok: false,
            kind: "source_not_owner",
            detail: "Only the source document owner can move it into a version.",
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
    const contentType = contentTypeForDocumentType(suffix);

    try {
        await uploadFile(key, bytes, contentType);
    } catch (e) {
        console.error("[versions/copy] storage write failed", e);
        return {
            ok: false,
            kind: "storage_write",
            detail: "Failed to create new version.",
        };
    }

    let pdfStoragePath: string | null = null;
    let deferConversion = false;
    if (suffix === "pdf") {
        pdfStoragePath = key;
    } else if (active.pdf_storage_path) {
        if (active.pdf_storage_path === active.storage_path) {
            pdfStoragePath = key;
        } else {
            const pdfBytes = await downloadFile(active.pdf_storage_path);
            if (pdfBytes) {
                const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
                await uploadFile(pdfKey, pdfBytes, "application/pdf");
                pdfStoragePath = pdfKey;
            }
        }
    } else if (shouldConvertToPdf(suffix)) {
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

    const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", ["upload", "user_upload", "assistant_edit"])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    const nextVersionNumber =
        ((maxRow?.version_number as number | null) ?? 1) + 1;

    const { data: versionRow, error: verErr } = await db
        .from("document_versions")
        .insert({
            document_id: documentId,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
            source: "user_upload",
            version_number: nextVersionNumber,
            filename: filename,
            file_type: sourceType || null,
            size_bytes: active.size_bytes ?? bytes.byteLength,
            page_count: active.page_count,
            content_sha256: contentSha256(bytes),
        })
        .select("id, version_number, source, created_at, filename")
        .single();
    if (verErr || !versionRow) {
        console.error("[versions/copy] insert failed", verErr);
        return {
            ok: false,
            kind: "version_insert",
            detail: "Failed to record new version.",
        };
    }

    const { error: updateDocErr } = await db
        .from("documents")
        .update({
            current_version_id: versionRow.id,
        })
        .eq("id", documentId);
    if (updateDocErr) {
        console.error("[versions/copy] current version update failed", updateDocErr);
        return {
            ok: false,
            kind: "doc_update",
            detail: "Failed to update document current version.",
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
            console.error("[versions/copy] source document delete failed", deleteErr);
            return {
                ok: false,
                kind: "source_delete",
                detail: "Failed to delete source document.",
            };
        }
    }

    return { ok: true, version: versionRow };
}

// ---------------------------------------------------------------------------
// Create version from an uploaded file (orchestration after HTTP validation)
// ---------------------------------------------------------------------------

export async function addUploadedVersion(
    params: {
        userId: string;
        documentId: string;
        file: UploadedFile;
        suffix: string;
        requestedFilename: unknown;
    },
    db: Db,
): Promise<
    | { ok: true; version: unknown }
    | { ok: false; detail: string }
> {
    const { userId, documentId, file, suffix } = params;

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
        userId,
        documentId,
        versionSlug,
        file.originalname,
    );
    const contentType = contentTypeForDocumentType(suffix);
    try {
        await uploadFile(
            key,
            file.buffer.buffer.slice(
                file.buffer.byteOffset,
                file.buffer.byteOffset + file.buffer.byteLength,
            ) as ArrayBuffer,
            contentType,
        );
    } catch (e) {
        console.error("[versions/upload] storage write failed", e);
        return { ok: false, detail: "Failed to upload new version." };
    }

    // Render this version's bytes to PDF up front so /display can show
    // historical versions without on-demand conversion. Same logic as the
    // initial-upload pipeline; failures don't block the version row.
    // With the job queue enabled the LibreOffice work is deferred to the
    // conversion worker instead of blocking this request; the version row is
    // created with pdf_storage_path null and the worker fills it in.
    const deferConversion =
        shouldConvertToPdf(suffix) &&
        process.env.ASYNC_DOCUMENT_CONVERSION === "true";
    let pdfStoragePath: string | null = null;
    if (!deferConversion && shouldConvertToPdf(suffix)) {
        try {
            const pdfBuf = await docxToPdf(file.buffer);
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
                "[versions/upload] Office→PDF conversion failed",
                { filename: file.originalname },
                err,
            );
        }
    } else if (suffix === "pdf") {
        // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
        pdfStoragePath = key;
    }

    const rawBuf = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // Per-document sequential version_number — the upload is V1 and
    // user_upload + assistant_edit count forward from there.
    const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", ["upload", "user_upload", "assistant_edit"])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    const nextVersionNumber =
        ((maxRow?.version_number as number | null) ?? 1) + 1;

    const requestedFilename =
        typeof params.requestedFilename === "string" &&
        params.requestedFilename.trim()
            ? params.requestedFilename.trim().slice(0, 200)
            : file.originalname;

    const { data: versionRow, error: verErr } = await db
        .from("document_versions")
        .insert({
            document_id: documentId,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
            source: "user_upload",
            version_number: nextVersionNumber,
            filename: requestedFilename,
            file_type: suffix,
            size_bytes: file.buffer.byteLength,
            page_count: pageCount,
            content_sha256: contentSha256(file.buffer),
        })
        .select("id, version_number, source, created_at, filename")
        .single();
    if (verErr || !versionRow) {
        console.error("[versions/upload] insert failed", verErr);
        return { ok: false, detail: "Failed to record new version." };
    }

    const { error: updateDocErr } = await db
        .from("documents")
        .update({
            current_version_id: versionRow.id,
        })
        .eq("id", documentId);
    if (updateDocErr) {
        console.error(
            "[versions/upload] current version update failed",
            updateDocErr,
        );
        return { ok: false, detail: "Failed to update document current version." };
    }

    if (deferConversion) {
        // The document itself stays "ready" — only this version's rendition is
        // pending, so the worker must not touch documents.status.
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

    return { ok: true, version: versionRow };
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

    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, detail: "Document not found" };

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
// Replace a version's file bytes (owner-only; destructive)
// ---------------------------------------------------------------------------

/**
 * Load the version targeted by a replace request and verify it exists and is
 * not deleted. Returns the version's existing storage paths (needed for
 * cleanup) plus its declared file_type (so the route can run the
 * extension-then-type-mismatch validation in its original order).
 */
export async function loadReplaceTarget(
    documentId: string,
    versionId: string,
    db: Db,
): Promise<
    | {
          ok: true;
          target: {
              storage_path: string | null;
              pdf_storage_path: string | null;
              file_type: string | null;
          };
      }
    | { ok: false; kind: "version_not_found" | "deleted"; detail: string }
> {
    const { data: target, error: targetErr } = await db
        .from("document_versions")
        .select("id, storage_path, pdf_storage_path, file_type, deleted_at")
        .eq("id", versionId)
        .eq("document_id", documentId)
        .single();
    if (targetErr || !target)
        return {
            ok: false,
            kind: "version_not_found",
            detail: "Version not found",
        };
    if (target.deleted_at)
        return { ok: false, kind: "deleted", detail: "Version is deleted." };
    return {
        ok: true,
        target: {
            storage_path: target.storage_path as string | null,
            pdf_storage_path: target.pdf_storage_path as string | null,
            file_type: target.file_type as string | null,
        },
    };
}

export async function writeReplacementVersion(
    params: {
        userId: string;
        documentId: string;
        versionId: string;
        file: UploadedFile;
        suffix: string;
        requestedFilename: unknown;
        target: { storage_path: string | null; pdf_storage_path: string | null };
    },
    db: Db,
): Promise<
    | { ok: true; version: unknown }
    // The storage write is reported with its own user-facing detail; the row
    // update is an opaque internal error the route reports via
    // sendInternalError, so it carries the raw error instead.
    | { ok: false; kind: "storage_write"; detail: string }
    | { ok: false; kind: "update_failed"; error: unknown }
> {
    const { userId, documentId, versionId, file, suffix, target } = params;

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
        userId,
        documentId,
        versionSlug,
        file.originalname,
    );
    const contentType = contentTypeForDocumentType(suffix);

    try {
        await uploadFile(
            key,
            file.buffer.buffer.slice(
                file.buffer.byteOffset,
                file.buffer.byteOffset + file.buffer.byteLength,
            ) as ArrayBuffer,
            contentType,
        );
    } catch (e) {
        console.error("[versions/replace] storage write failed", e);
        return {
            ok: false,
            kind: "storage_write",
            detail: "Failed to upload replacement version.",
        };
    }

    // Same queue deferral as version uploads: the replacement's rendition is
    // produced by the conversion worker when the flag is on. The old rendition
    // is deleted below either way, so /display briefly falls back until the
    // worker writes the new one.
    const deferConversion =
        shouldConvertToPdf(suffix) &&
        process.env.ASYNC_DOCUMENT_CONVERSION === "true";
    let pdfStoragePath: string | null = null;
    if (!deferConversion && shouldConvertToPdf(suffix)) {
        try {
            const pdfBuf = await docxToPdf(file.buffer);
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
                "[versions/replace] Office→PDF conversion failed",
                { filename: file.originalname },
                err,
            );
        }
    } else if (suffix === "pdf") {
        pdfStoragePath = key;
    }

    const rawBuf = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;
    const requestedFilename =
        typeof params.requestedFilename === "string" &&
        params.requestedFilename.trim()
            ? params.requestedFilename.trim().slice(0, 200)
            : file.originalname;
    const uploadedAt = new Date().toISOString();

    const { data: updated, error: updateErr } = await db
        .from("document_versions")
        .update({
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
            filename: requestedFilename,
            file_type: suffix,
            size_bytes: file.buffer.byteLength,
            page_count: pageCount,
            content_sha256: contentSha256(file.buffer),
            created_at: uploadedAt,
        })
        .eq("id", versionId)
        .eq("document_id", documentId)
        .select(
            "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
        )
        .single();
    if (updateErr || !updated) {
        await Promise.all(
            [key, pdfStoragePath]
                .filter((path): path is string => !!path)
                .map((path) => deleteFile(path).catch(() => {})),
        );
        return {
            ok: false,
            kind: "update_failed",
            error:
                updateErr ?? new Error("Version replacement returned no data"),
        };
    }

    await Promise.all(
        [target.storage_path, target.pdf_storage_path]
            .filter((path): path is string => !!path)
            .map((path) => deleteFile(path).catch(() => {})),
    );

    if (deferConversion) {
        // Replace reuses the versionId, which is exactly why terminal jobs are
        // removed from the queue immediately — this enqueue must not be deduped
        // against a completed job for the same version.
        await enqueueConversion({
            documentId,
            versionId,
            userId,
            storagePath: key,
            fileType: suffix,
            pdfKey: `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
            finalizeDocumentStatus: false,
        });
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
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db, {
        select: "id, user_id, project_id, current_version_id",
        ownerOnly: true,
    });
    if (!access.ok)
        return { ok: false, kind: "doc_not_found", detail: "Document not found" };
    const doc = access.doc;

    const { data: versions, error: versionsErr } = await db
        .from("document_versions")
        .select(
            "id, storage_path, pdf_storage_path, version_number, created_at, deleted_at",
        )
        .eq("document_id", documentId)
        .is("deleted_at", null);
    if (versionsErr) {
        return { ok: false, kind: "db", error: versionsErr };
    }

    const rows = (versions ?? []) as {
        id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        created_at: string | null;
        deleted_at?: string | null;
    }[];
    const target = rows.find((row) => row.id === versionId);
    if (!target)
        return { ok: false, kind: "version_not_found", detail: "Version not found" };
    if (rows.length <= 1) {
        return {
            ok: false,
            kind: "only_version",
            detail: "Cannot delete the only document version.",
        };
    }

    const remaining = rows
        .filter((row) => row.id !== versionId)
        .sort((a, b) => {
            const versionDelta =
                (b.version_number ?? -1) - (a.version_number ?? -1);
            if (versionDelta !== 0) return versionDelta;
            return (
                new Date(b.created_at ?? 0).getTime() -
                new Date(a.created_at ?? 0).getTime()
            );
        });
    const nextCurrentVersionId =
        doc.current_version_id === versionId
            ? (remaining[0]?.id ?? null)
            : doc.current_version_id;
    const deletedAt = new Date().toISOString();

    if (doc.current_version_id === versionId) {
        const { error: updateErr } = await db
            .from("documents")
            .update({
                current_version_id: nextCurrentVersionId,
                updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        if (updateErr) {
            return { ok: false, kind: "db", error: updateErr };
        }
    }

    const { error: deleteErr } = await db
        .from("document_versions")
        .update({
            storage_path: null,
            pdf_storage_path: null,
            deleted_at: deletedAt,
            deleted_by: userId,
        })
        .eq("id", versionId)
        .eq("document_id", documentId)
        .is("deleted_at", null);
    if (deleteErr) {
        return { ok: false, kind: "db", error: deleteErr };
    }

    await Promise.all(
        [target.storage_path, target.pdf_storage_path]
            .filter((path): path is string => !!path)
            .map((path) => deleteFile(path).catch(() => {})),
    );

    return {
        ok: true,
        payload: {
            deleted_version_id: versionId,
            current_version_id: nextCurrentVersionId,
            deleted_at: deletedAt,
        },
    };
}
