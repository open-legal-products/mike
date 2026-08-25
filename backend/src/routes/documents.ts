import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import {
  contentTypeForDocumentType,
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
  // Storage lives on document_versions — fan out and delete each version's
  // bytes (source + PDF rendition) before dropping the document row.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    (versions ?? []).flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  return db.from("documents").delete().eq("id", documentId);
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

// POST /single-documents/download-zip
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
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
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

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// Produce the filename a download should present to the user. Version
// filenames are expected to include the real extension.
function downloadFilenameForVersion(
  filename: string | null | undefined,
  versionNumber: number | null,
  edited = false,
): string {
  const resolved = filename?.trim() || "Untitled document.docx";
  if (!edited || !versionNumber || versionNumber < 1) return resolved;
  const dot = resolved.lastIndexOf(".");
  const stem = dot > 0 ? resolved.slice(0, dot) : resolved;
  const ext = dot > 0 ? resolved.slice(dot) : "";
  return `${stem} [Edited V${versionNumber}]${ext}`;
}

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
          `[versions/copy] Office→PDF conversion failed for ${filename}:`,
          err,
        );
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

  await db
    .from("document_versions")
    .update({ content_sha256: contentSha256(ab) })
    .eq("id", doc.current_version_id);

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
