// HTTP layer for the documents module. Handlers parse params/query/body,
// call the service functions behind documents.service.ts, and map their typed
// results onto status codes, headers, and response bodies. The one piece of
// logic that stays here is the download-zip streaming loop, because it exists
// to apply `res` backpressure to the object-storage reads.

import { Router } from "express";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { buildContentDisposition, createFileReadStream } from "../../lib/storage";
import { sendDocumentDisplay } from "../../lib/documentDisplay";
import { uniqueArchiveFilename } from "../../lib/zipExport";
import {
    listSingleDocuments,
    getDocument,
    deleteDocument,
    getDisplayableVersion,
    resolveZipExportDocuments,
    getDownloadUrl,
    getDocxBytes,
    listVersions,
    createVersionFromDocument,
    renameVersion,
    deleteVersion,
    getTrackedChangeIds,
    resolveEdit,
} from "./documents.service";

export const documentsRouter = Router();

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listSingleDocuments(userId, db);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.docs);
});

// GET /single-documents/:documentId
// One document, same shape as a list entry — the client polls this while a
// deferred conversion runs instead of refetching the whole collection.
documentsRouter.get("/:documentId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await getDocument(documentId, userId, userEmail, db);
    if (!result.ok)
        return void res.status(404).json({ detail: "Document not found" });
    res.json(result.doc);
});

// POST /single-documents is intentionally absent: multipart upload was
// replaced by the direct object-storage upload-session protocol, and app.ts
// answers 410 on the former path before any body parser reads file bytes.

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await deleteDocument(documentId, userId, db);
    if (!result.ok)
        return void res.status(404).json({ detail: "Document not found" });
    res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const result = await getDisplayableVersion(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
    );
    if (!result.ok) {
        if (result.kind === "error")
            return void sendInternalError(res, result.error);
        return void res.status(404).json({ detail: result.detail });
    }
    sendDocumentDisplay(res, result.display);
});

// POST /single-documents/download-zip
// Accepts `document_ids` and/or `folder_ids`; folders expand to every
// document beneath them. Synchronous zip, kept for small selections (instant
// download, no polling). Large selections go through the durable
// "documents-zip" export job instead.
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { document_ids, folder_ids } = req.body as {
        document_ids?: string[];
        folder_ids?: string[];
    };
    const documentIds = Array.isArray(document_ids)
        ? [...new Set(document_ids.filter((id) => typeof id === "string"))]
        : [];
    const folderIds = Array.isArray(folder_ids)
        ? [...new Set(folder_ids.filter((id) => typeof id === "string"))]
        : [];

    if (documentIds.length === 0 && folderIds.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids or folder_ids is required" });

    const db = createServerSupabase();
    const result = await resolveZipExportDocuments(
        { documentIds, folderIds, userId, userEmail },
        db,
    );
    if (!result.ok) {
        if (result.kind === "internal")
            return void sendInternalError(res, result.error);
        const status = result.kind === "limit" ? 413 : 404;
        return void res.status(status).json({ detail: result.detail });
    }

    // Streaming lives here rather than in the service: each entry is read
    // lazily from object storage and the archive is piped straight into `res`,
    // so the response object is what applies backpressure. Nothing is
    // buffered, and STORE (no deflate) keeps already-compressed office files
    // from being recompressed.
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const usedNames = new Set<string>();
    const fileStreams = result.entries.map((entry) => {
        const stream = createFileReadStream(entry.storagePath);
        zip.file(uniqueArchiveFilename(entry.filename, usedNames), stream, {
            compression: "STORE",
        });
        return stream;
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
    const archiveStream = zip.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        compression: "STORE",
    }) as Readable;
    try {
        await pipeline(archiveStream, res);
    } catch (error) {
        // Destroy the per-file readers so a failed archive does not leave
        // object-storage GETs open. Once bytes are on the wire the status is
        // already sent, so only a pre-headers failure can be reported.
        for (const stream of fileStreams) stream.destroy();
        if (!res.headersSent && !res.destroyed) {
            return void sendInternalError(res, error);
        }
    }
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const result = await getDownloadUrl(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
    );
    if (!result.ok) {
        const status = result.kind === "storage" ? 503 : 404;
        return void res.status(status).json({ detail: result.detail });
    }
    res.json(result.payload);
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const result = await getDocxBytes(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
    );
    if (!result.ok)
        return void res.status(404).json({ detail: result.detail });

    res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("inline", result.filename),
    );
    res.send(Buffer.from(result.bytes));
});

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await listVersions(documentId, userId, userEmail, db);
    if (!result.ok)
        return void res.status(404).json({ detail: result.detail });

    res.json({
        current_version_id: result.current_version_id,
        versions: result.versions,
    });
});

// POST /single-documents/:documentId/versions/from-document
// Create a new version of documentId from another existing document's active
// bytes. This keeps signed storage URLs out of the browser fetch path.
documentsRouter.post(
    "/:documentId/versions/from-document",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId } = req.params;
        const sourceDocumentId =
            typeof req.body?.source_document_id === "string"
                ? req.body.source_document_id
                : "";
        const db = createServerSupabase();

        if (!sourceDocumentId) {
            return void res
                .status(400)
                .json({ detail: "source_document_id is required" });
        }
        if (sourceDocumentId === documentId) {
            return void res
                .status(400)
                .json({ detail: "Source and target documents must be different." });
        }

        const result = await createVersionFromDocument(
            {
                documentId,
                sourceDocumentId,
                requestedFilename:
                    typeof req.body?.filename === "string"
                        ? req.body.filename
                        : null,
                userId,
                userEmail,
            },
            db,
        );
        if (!result.ok) {
            const status =
                result.kind === "source_not_owner"
                    ? 403
                    : result.kind === "target_not_found" ||
                        result.kind === "source_not_found" ||
                        result.kind === "source_no_active" ||
                        result.kind === "source_bytes"
                      ? 404
                      : 500;
            return void res.status(status).json({ detail: result.detail });
        }
        res.status(201).json(result.version);
    },
);

// POST /single-documents/:documentId/versions and
// PUT /single-documents/:documentId/versions/:versionId/file are intentionally
// absent for the same reason as POST /single-documents: multipart version
// upload and replacement moved to the upload-session protocol, and app.ts
// answers 410 on both former paths.

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's filename. Pass `{ "filename": "…" }`.
documentsRouter.patch(
    "/:documentId/versions/:versionId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();

        const result = await renameVersion(
            {
                documentId,
                versionId,
                rawFilename: req.body?.filename,
                userId,
                userEmail,
            },
            db,
        );
        if (!result.ok)
            return void res.status(404).json({ detail: result.detail });
        res.json(result.version);
    },
);

// DELETE /single-documents/:documentId/versions/:versionId
// Delete one version. The last remaining version cannot be deleted; if the
// deleted version is current, the newest remaining version becomes current.
documentsRouter.delete(
    "/:documentId/versions/:versionId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();

        const result = await deleteVersion(
            documentId,
            versionId,
            userId,
            userEmail,
            db,
        );
        if (!result.ok) {
            if (result.kind === "db")
                return void sendInternalError(res, result.error);
            const status =
                result.kind === "doc_not_found" ||
                result.kind === "version_not_found"
                    ? 404
                    : 400;
            return void res.status(status).json({ detail: result.detail });
        }
        res.json(result.payload);
    },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
    "/:documentId/tracked-change-ids",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId } = req.params;
        const versionIdParam =
            typeof req.query.version_id === "string" ? req.query.version_id : null;
        const db = createServerSupabase();

        const result = await getTrackedChangeIds(
            documentId,
            userId,
            userEmail,
            versionIdParam,
            db,
        );
        if (!result.ok)
            return void res.status(404).json({ detail: result.detail });
        res.json({ ids: result.ids });
    },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
    req: import("express").Request,
    res: import("express").Response,
    mode: "accept" | "reject",
) {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, editId } = req.params;
    const db = createServerSupabase();

    const result = await resolveEdit(
        mode,
        documentId,
        editId,
        userId,
        userEmail,
        db,
    );
    if (!result.ok)
        return void res.status(404).json({ detail: result.detail });
    res.json(result.body);
}

documentsRouter.post(
    "/:documentId/edits/:editId/accept",
    requireAuth,
    (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
    "/:documentId/edits/:editId/reject",
    requireAuth,
    (req, res) => void handleEditResolution(req, res, "reject"),
);
