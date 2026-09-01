import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  extractedTextKey,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { enqueueConversion } from "../lib/queue/conversionQueue";
import { enqueueDbJob, enqueueStorageCleanup } from "../lib/dbq/enqueue";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
  downloadFilenameForVersion,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import {
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_TYPES_LABEL,
  contentTypeForDocumentType,
  requiresLibreOfficeTextExtraction,
  shouldConvertToPdf,
} from "../lib/documentTypes";

export const documentsRouter = Router();
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

async function deleteDocumentAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
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

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .or("library_kind.eq.file,library_kind.is.null")
    .order("created_at", { ascending: false });
  if (error) return void sendInternalError(res, error);
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// GET /single-documents/:documentId
// One document, same shape as a list entry. Exists so the client can poll a
// single document's status while a deferred conversion runs, instead of
// refetching the whole collection.
documentsRouter.get("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .single();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const docs = [doc] as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs[0]);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db, {
      libraryKind: "file",
    });
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  await deleteDocumentAndVersionFiles(db, documentId);
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

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = active.file_type ?? "";
  const isConvertibleOffice = shouldConvertToPdf(fileType);
  const displayFilename = downloadFilenameForVersion(
    active.filename,
    active.version_number,
    active.source === "assistant_edit",
  );

  // For Office files, prefer the per-version PDF rendition if one exists.
  const servePath =
    isConvertibleOffice && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isConvertibleOffice && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", displayFilename),
    );
    res.send(Buffer.from(raw));
  } else {
    // Fallback: serve raw Office bytes when PDF conversion was unavailable.
    res.setHeader("Content-Type", contentTypeForDocumentType(fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", displayFilename),
    );
    res.send(Buffer.from(raw));
  }
});

// GET /single-documents/:documentId/file
// Downloads active-version or `?version_id` source bytes for browser editors. 
// this bypasses R2 (avoids the browser CORS problem on signed URLs) so the frontend
// docx-preview viewer can load tracked-change documents directly. Unlike /display,
// this never substitutes a generated PDF rendition for an Office document.
documentsRouter.get("/:documentId/file", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });
  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const filename = downloadFilenameForVersion(
    active.filename,
    active.version_number,
    active.source === "assistant_edit",
  );
  res.setHeader("Content-Type", contentTypeForDocumentType(active.file_type));
  res.setHeader("Content-Disposition", buildContentDisposition("inline", filename));
  res.send(Buffer.from(raw));
});

// POST /single-documents/download-zip
// Synchronous zip, kept for small selections (instant download, no polling).
// Large selections go through the durable "documents-zip" export job instead.
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void sendInternalError(res, error);
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(
        downloadFilenameForVersion(
          active.filename,
          active.version_number,
          active.source === "assistant_edit",
        ),
        Buffer.from(raw),
      );
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = downloadFilenameForVersion(
    active.filename,
    active.version_number,
    active.source === "assistant_edit",
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Permanent compatibility redirect for old docx-preview callers. /file owns
// source-byte downloads and query parameters, including ?version_id=.
documentsRouter.get("/:documentId/docx", (req, res) => {
  const queryIndex = req.originalUrl.indexOf("?");
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
  res.redirect(
    301,
    `${req.baseUrl}/${encodeURIComponent(req.params.documentId)}/file${query}`,
  );
});

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at, deleted_by",
    )
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
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

    const { data: targetDoc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!targetDoc)
      return void res.status(404).json({ detail: "Document not found" });
    const targetAccess = await ensureDocAccess(targetDoc, userId, userEmail, db);
    if (!targetAccess.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: sourceDoc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", sourceDocumentId)
      .single();
    if (!sourceDoc)
      return void res.status(404).json({ detail: "Source document not found" });
    const sourceAccess = await ensureDocAccess(sourceDoc, userId, userEmail, db);
    if (!sourceAccess.ok)
      return void res.status(404).json({ detail: "Source document not found" });
    const willDeleteSource =
      (sourceDoc.project_id &&
        targetDoc.project_id &&
        sourceDoc.project_id === targetDoc.project_id) ||
      (!sourceDoc.project_id &&
        !targetDoc.project_id &&
        sourceDoc.user_id === userId &&
        targetDoc.user_id === userId);
    if (willDeleteSource && !sourceAccess.isOwner) {
      return void res.status(403).json({
        detail: "Only the source document owner can move it into a version.",
      });
    }

    const active = await loadActiveVersion(sourceDocumentId, db);
    if (!active)
      return void res
        .status(404)
        .json({ detail: "Source document has no active version." });
    const sourceType = active.file_type ?? "";

    const bytes = await downloadFile(active.storage_path);
    if (!bytes)
      return void res
        .status(404)
        .json({ detail: "Source document bytes not available." });

    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
        : active.filename?.trim() || "Untitled document";
    const suffix =
      sourceType ||
      (filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "");
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, filename);
    const contentType = contentTypeForDocumentType(suffix);

    try {
      await uploadFile(key, bytes, contentType);
    } catch (e) {
      console.error("[versions/copy] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to create new version." });
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
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    const { error: updateDocErr } = await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
      })
      .eq("id", documentId);
    if (updateDocErr) {
      console.error("[versions/copy] current version update failed", updateDocErr);
      return void res
        .status(500)
        .json({ detail: "Failed to update document current version." });
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
        return void res
          .status(500)
          .json({ detail: "Failed to delete source document." });
      }
    }

    res.status(201).json(versionRow);
  },
);

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. filename defaults to the
// uploaded filename; client may override via the `filename` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, current_version_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
      return void res.status(400).json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });
    }

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
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
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
          `[versions/upload] Office→PDF conversion failed for ${file.originalname}:`,
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
      typeof req.body?.filename === "string" &&
      req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
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
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
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
      return void res
        .status(500)
        .json({ detail: "Failed to update document current version." });
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

    res.status(201).json(versionRow);
  },
);

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

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.filename;
    const filename =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

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
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// PUT /single-documents/:documentId/versions/:versionId/file
// Replace the file bytes and metadata for an existing version while keeping
// its version number and id. This is destructive and owner-only.
documentsRouter.put(
  "/:documentId/versions/:versionId/file",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok || !access.isOwner)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: target, error: targetErr } = await db
      .from("document_versions")
      .select("id, storage_path, pdf_storage_path, file_type, deleted_at")
      .eq("id", versionId)
      .eq("document_id", documentId)
      .single();
    if (targetErr || !target)
      return void res.status(404).json({ detail: "Version not found" });
    if (target.deleted_at)
      return void res.status(400).json({ detail: "Version is deleted." });

    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
      return void res.status(400).json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });
    }
    if (target.file_type && target.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match version type (${target.file_type}).`,
      });
    }

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
      return void res
        .status(500)
        .json({ detail: "Failed to upload replacement version." });
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
          `[versions/replace] Office→PDF conversion failed for ${file.originalname}:`,
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
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
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
      return void sendInternalError(
        res,
        updateErr ?? new Error("Version replacement returned no data"),
      );
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

    res.json(updated);
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

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, current_version_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok || !access.isOwner)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: versions, error: versionsErr } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, version_number, created_at, deleted_at",
      )
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (versionsErr) {
      return void sendInternalError(res, versionsErr);
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
      return void res.status(404).json({ detail: "Version not found" });
    if (rows.length <= 1) {
      return void res
        .status(400)
        .json({ detail: "Cannot delete the only document version." });
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
        return void sendInternalError(res, updateErr);
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
      return void sendInternalError(res, deleteErr);
    }

    await Promise.all(
      [target.storage_path, target.pdf_storage_path]
        .filter((path): path is string => !!path)
        .map((path) => deleteFile(path).catch(() => {})),
    );

    res.json({
      deleted_version_id: versionId,
      current_version_id: nextCurrentVersionId,
      deleted_at: deletedAt,
    });
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

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
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

  devLog(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  devLog(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    devLog(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    devLog(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      devLog(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      devLog(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            downloadFilenameForVersion(
              activeForResolved.filename,
              activeForResolved.version_number,
              activeForResolved.source === "assistant_edit",
            ),
          )
        : null,
      remaining_pending: 0,
    };
    devLog(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  devLog(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  devLog(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  devLog(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  devLog(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    devLog(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", editId);
    devLog(`[edit-resolution] status-only update`, { updErr });
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        downloadFilenameForVersion(
          active?.filename,
          active?.version_number ?? null,
          active?.source === "assistant_edit",
        ),
      ),
      remaining_pending: 0,
    };
    devLog(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;

  // Clear the hash before the bytes change, and set it again after. The stored
  // object and the hash live in different systems, so they cannot be written
  // atomically; ordering it this way means a failure in between leaves the
  // version unhashed, which the manifest reports as unverifiable. The
  // alternative ordering can leave a hash attesting to content the version no
  // longer holds, which is the one thing the manifest must never do.
  await db
    .from("document_versions")
    .update({ content_sha256: null })
    .eq("id", doc.current_version_id);

  devLog(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  // pdf_storage_path: null — the bytes just changed, so any PDF rendition
  // this version carried no longer matches them; a stale rendition would be
  // served by /display and copied onto replicas by replicate_document. In
  // practice assistant_edit versions never carry one (DOCX renders through
  // DocxView from the raw bytes), so this is an invariant write, not a
  // behavior change.
  await db
    .from("document_versions")
    .update({ content_sha256: contentSha256(ab), pdf_storage_path: null })
    .eq("id", doc.current_version_id);

  // The extracted-text cache is keyed on the version id and this is one of
  // only two sites that rewrite a version's bytes in place, so it is one of
  // only two sites where that key could go stale. Resolution always writes
  // DOCX, which is not a cached type, so this deletes nothing today — it is
  // here so the "versions are immutable" assumption the cache rests on stays
  // true by construction rather than by coincidence.
  await enqueueStorageCleanup(db, [
    extractedTextKey(doc.current_version_id as string),
  ]);

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  devLog(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });
  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  devLog(`[edit-resolution] remaining pending count`, { remainingPending });

  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      downloadFilenameForVersion(
        active?.filename,
        active?.version_number ?? null,
        active?.source === "assistant_edit",
      ),
    ),
    remaining_pending: remainingPending ?? 0,
  };
  devLog(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
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

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
  options: {
    libraryKind?: "file" | "template";
    libraryFolderId?: string | null;
  } = {},
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });

  const content = file.buffer;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      status: "processing",
      library_kind: options.libraryKind ?? "file",
      library_folder_id: options.libraryFolderId ?? null,
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
  if (insertErr || !doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

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
          `[upload] Office→PDF conversion failed for ${filename}:`,
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
          folder_id:
            (updated.library_folder_id as string | null | undefined) ?? null,
          file_type: suffix,
          size_bytes: content.byteLength,
          page_count: pageCount,
          active_version_number: 1,
        }
      : updated;
    void recordAudit(db, {
      userId,
      userEmail: res.locals.userEmail as string | undefined,
      action: "document.uploaded",
      title: filename,
      surface: "assistant",
      documentId: (updated as { id?: string } | null)?.id ?? null,
    });
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void sendInternalError(res, e);
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}
