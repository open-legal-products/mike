// Initial document creation from an uploaded file.

import { recordAudit } from "../../lib/audit";
import { storageKey, uploadFile } from "../../lib/storage";
import { docxToPdf, convertedPdfKey } from "../../lib/convert";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { contentSha256 } from "../../lib/documentVersions";
import {
    contentTypeForDocumentType,
    requiresLibreOfficeTextExtraction,
    shouldConvertToPdf,
} from "../../lib/documentTypes";
import { countPdfPages, type Db } from "./documents.shared";

// ---------------------------------------------------------------------------
// Create a document from an uploaded file (initial upload pipeline)
// ---------------------------------------------------------------------------

export async function createDocumentFromUpload(
    params: {
        userId: string;
        projectId: string | null;
        filename: string;
        suffix: string;
        content: Buffer;
        libraryKind?: "file" | "template";
        libraryFolderId?: string | null;
        // Project-tab folder (documents.folder_id), distinct from the library's
        // own folder column above. Set by the project upload route, which used
        // to run a forked copy of this function to get it.
        folderId?: string | null;
        userEmail?: string;
        // Which part of the product the upload came from — recorded on the
        // audit event so project uploads show up under the project rather than
        // the assistant. Defaults to the assistant/library surface.
        surface?: "project" | "assistant";
    },
    db: Db,
): Promise<
    | { ok: true; doc: unknown }
    | { ok: false; kind: "create_failed" }
    // Anything thrown by the storage / conversion / version pipeline is an
    // opaque internal error: the raw value travels back so the route can hand
    // it to sendInternalError, which logs it and returns the generic body.
    | { ok: false; kind: "processing_failed"; error: unknown }
> {
    const { userId, projectId, filename, suffix, content } = params;

    const { data: doc, error: insertErr } = await db
        .from("documents")
        .insert({
            project_id: projectId,
            user_id: userId,
            status: "processing",
            library_kind: params.libraryKind ?? "file",
            library_folder_id: params.libraryFolderId ?? null,
            folder_id: params.folderId ?? null,
        })
        .select("*")
        .single();

    if (insertErr || !doc)
        console.error("[single-documents/upload] failed to create document row", {
            userId,
            projectId,
            filename,
            suffix,
            error: insertErr,
        });
    if (insertErr || !doc) return { ok: false, kind: "create_failed" };

    try {
        const docId = doc.id as string;
        const key = storageKey(userId, docId, filename);
        const contentType = contentTypeForDocumentType(suffix);
        await uploadFile(
            key,
            content.buffer.slice(
                content.byteOffset,
                content.byteOffset + content.byteLength,
            ) as ArrayBuffer,
            contentType,
        );

        const rawBuf = content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
        const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

        // When the job queue is enabled, defer Office → PDF conversion to the
        // BullMQ worker instead of blocking the upload request on LibreOffice.
        const deferConversion =
            shouldConvertToPdf(suffix) &&
            process.env.ASYNC_DOCUMENT_CONVERSION === "true";

        // Convert Office files → PDF for display. PDFs are their own rendition.
        let pdfStoragePath: string | null = null;
        if (!deferConversion && shouldConvertToPdf(suffix)) {
            try {
                const pdfBuf = await docxToPdf(content);
                const pdfKey = convertedPdfKey(userId, docId);
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
                    "[upload] Office→PDF conversion failed",
                    { filename },
                    err,
                );
            }
        } else if (suffix === "pdf") {
            pdfStoragePath = key;
        }

        // storage_path / pdf_storage_path live on document_versions now —
        // create the V1 "upload" row and point documents.current_version_id
        // at it.
        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: docId,
                storage_path: key,
                pdf_storage_path: pdfStoragePath,
                source: "upload",
                version_number: 1,
                filename: filename,
                file_type: suffix,
                size_bytes: content.byteLength,
                page_count: pageCount,
                content_sha256: contentSha256(content),
            })
            .select("id")
            .single();
        if (verErr || !versionRow) {
            throw new Error(
                `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
            );
        }

        await db
            .from("documents")
            .update({
                current_version_id: versionRow.id,
                // Deferred conversion leaves the doc "processing" until the worker
                // produces the PDF and flips it to "ready".
                status: deferConversion ? "processing" : "ready",
                updated_at: new Date().toISOString(),
            })
            .eq("id", docId);

        if (deferConversion) {
            await enqueueConversion({
                documentId: docId,
                versionId: versionRow.id,
                userId,
                storagePath: key,
                fileType: suffix,
            });
        }

        // .doc/.ppt are the only types read_document can read solely by paying
        // for a LibreOffice conversion. Extract that text once now, in the
        // background, so the first chat that reads this document does not pay a
        // subprocess round trip inside its own tool call. Best-effort: a failed
        // enqueue just means the read path converts inline and re-queues itself.
        if (requiresLibreOfficeTextExtraction(suffix)) {
            try {
                await enqueueDbJob(db, {
                    kind: "document.precompute_text",
                    payload: {
                        versionId: versionRow.id,
                        storagePath: key,
                        fileType: suffix,
                        userId,
                    },
                    dedupeKey: `precompute:${versionRow.id}`,
                    maxAttempts: 3,
                });
            } catch (err) {
                console.error("[upload] precompute-text enqueue failed", err);
            }
        }

        const { data: updated } = await db
            .from("documents")
            .select("*")
            .eq("id", docId)
            .single();
        // Surface storage paths to the caller for backward compatibility.
        const responseDoc = updated
            ? {
                  ...updated,
                  filename,
                  storage_path: key,
                  pdf_storage_path: pdfStoragePath,
                  // The library surface presents its library_folder_id under
                  // the generic `folder_id` key; a project upload has a real
                  // documents.folder_id, so prefer that when it is set.
                  folder_id:
                      (updated.folder_id as string | null | undefined) ??
                      (updated.library_folder_id as string | null | undefined) ??
                      null,
                  file_type: suffix,
                  size_bytes: content.byteLength,
                  page_count: pageCount,
                  active_version_number: 1,
              }
            : updated;
        void recordAudit(db, {
            userId,
            userEmail: params.userEmail,
            action: "document.uploaded",
            title: filename,
            surface: params.surface ?? "assistant",
            projectId,
            documentId: (updated as { id?: string } | null)?.id ?? null,
        });
        return { ok: true, doc: responseDoc };
    } catch (e) {
        await db.from("documents").update({ status: "error" }).eq("id", doc.id);
        return { ok: false, kind: "processing_failed", error: e };
    }
}
