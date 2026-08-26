// Project document service functions: list, assign/copy an existing document
// into a project, and rename. Uploads go through the shared pipeline in
// modules/documents/documents.upload.ts — this module used to carry a
// drifted copy of it.

import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
} from "../../lib/documentVersions";
import {
  deleteFile,
  downloadFile,
  uploadFile,
  storageKey,
} from "../../lib/storage";
import { convertedPdfKey } from "../../lib/convert";
import { checkProjectAccess } from "../../lib/access";
import { contentTypeForDocumentType } from "../../lib/documentTypes";
import {
  type Db,
  attachDocumentOwnerLabels,
  loadProjectFolder,
  normalizeDocumentFilename,
} from "./projects.shared";

export async function listProjectDocuments(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<{ ok: true; docs: unknown } | { ok: false; kind: "forbidden" }> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  return { ok: true, docs: docsTyped };
}

// GET /projects/:projectId/directory
// Returns one folder level so file pickers can expand projects without
// downloading every document and subfolder for every project up front.
export async function getProjectDirectoryLevel(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    parentFolderId: string | null;
    pagination: { limit: number; offset: number };
  },
): Promise<
  | {
      ok: true;
      body: {
        documents: unknown[];
        folders: unknown[];
        documentsHasMore: boolean;
      };
    }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "db_error"; error: unknown }
> {
  const { projectId, userId, userEmail, parentFolderId, pagination } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  let documentsQuery = db
    .from("documents")
    .select("*")
    .eq("project_id", projectId);
  let foldersQuery = db
    .from("project_subfolders")
    .select("*")
    .eq("project_id", projectId);
  documentsQuery = parentFolderId
    ? documentsQuery.eq("folder_id", parentFolderId)
    : documentsQuery.is("folder_id", null);
  foldersQuery = parentFolderId
    ? foldersQuery.eq("parent_folder_id", parentFolderId)
    : foldersQuery.is("parent_folder_id", null);

  const [
    { data: documents, error: documentsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
    documentsQuery
      .order("updated_at", { ascending: false })
      .range(pagination.offset, pagination.offset + pagination.limit),
    foldersQuery.order("updated_at", { ascending: false }),
  ]);
  if (documentsError)
    return { ok: false, kind: "db_error", error: documentsError };
  if (foldersError)
    return { ok: false, kind: "db_error", error: foldersError };

  const rows = documents ?? [];
  const documentsHasMore = rows.length > pagination.limit;
  const page = (documentsHasMore ? rows.slice(0, pagination.limit) : rows) as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, page);
  await attachActiveVersionPaths(db, page);
  await attachDocumentOwnerLabels(db, page);
  return {
    ok: true,
    body: {
      documents: page,
      folders: folders ?? [],
      documentsHasMore,
    },
  };
}

export type AssignOrCopyResult =
  | { ok: true; status: 200 | 201; doc: unknown }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "doc_not_found" }
  | { ok: false; kind: "update_failed" }
  | { ok: false; kind: "no_active_version" }
  | { ok: false; kind: "read_failed" }
  | { ok: false; kind: "copy_failed" };

export async function assignOrCopyDocument(
  db: Db,
  args: {
    projectId: string;
    documentId: string;
    userId: string;
    userEmail?: string;
  },
): Promise<AssignOrCopyResult> {
  const { projectId, documentId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  // Adding-by-id pulls a doc into the project — only the doc's owner
  // is allowed to do that, so other people's standalone docs can't be
  // siphoned into a project the requester happens to share.
  const { data: doc } = await db
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (!doc) return { ok: false, kind: "doc_not_found" };
  await attachActiveVersionPaths(
    db,
    [doc as { id: string; current_version_id?: string | null }],
  );

  // Already in this project — idempotent
  if (doc.project_id === projectId) return { ok: true, status: 200, doc };

  if (doc.project_id === null) {
    // Standalone → assign project_id
    const { data: updated, error } = await db
      .from("documents")
      .update({
        project_id: projectId,
        library_folder_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .select("*")
      .single();
    if (error || !updated) return { ok: false, kind: "update_failed" };
    await attachActiveVersionPaths(
      db,
      [updated as { id: string; current_version_id?: string | null }],
    );
    return { ok: true, status: 200, doc: updated };
  } else {
    // Belongs to another project → duplicate record AND copy the
    // underlying storage objects so each project's copy is fully
    // independent (edits/version bumps on one don't leak into the
    // other).
    if (!doc.current_version_id) {
      return { ok: false, kind: "no_active_version" };
    }

    const { data: srcV } = await db
      .from("document_versions")
      .select(
        "storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count",
      )
      .eq("id", doc.current_version_id)
      .single();
    if (!srcV?.storage_path) {
      return { ok: false, kind: "no_active_version" };
    }

    const activeVersionFilename =
      (srcV.filename as string | null)?.trim() || "Untitled document";
    const srcBytes = await downloadFile(srcV.storage_path);
    if (!srcBytes) {
      return { ok: false, kind: "read_failed" };
    }

    const { data: copy, error } = await db
      .from("documents")
      .insert({
        project_id: projectId,
        user_id: userId,
        status: doc.status,
      })
      .select("*")
      .single();
    if (error || !copy) return { ok: false, kind: "copy_failed" };

    const newKey = storageKey(
      userId,
      copy.id as string,
      activeVersionFilename,
    );
    let newPdfPath: string | null = null;
    try {
      const contentType = contentTypeForDocumentType(
        (srcV.file_type as string | null) ?? doc.file_type,
      );
      await uploadFile(newKey, srcBytes, contentType);

      // PDFs share one object for source + display rendition. DOCX
      // store the converted PDF at a separate `converted-pdfs/` key —
      // copy that too if it exists so the copy renders without going
      // back through libreoffice.
      if (srcV.pdf_storage_path) {
        if (srcV.pdf_storage_path === srcV.storage_path) {
          newPdfPath = newKey;
        } else {
          const pdfBytes = await downloadFile(srcV.pdf_storage_path);
          if (pdfBytes) {
            const newPdfKey = convertedPdfKey(userId, copy.id as string);
            await uploadFile(newPdfKey, pdfBytes, "application/pdf");
            newPdfPath = newPdfKey;
          }
        }
      }

      const { data: newV, error: newVError } = await db
        .from("document_versions")
        .insert({
          document_id: copy.id,
          storage_path: newKey,
          pdf_storage_path: newPdfPath,
          source: (srcV.source as string | null) ?? "upload",
          version_number: srcV.version_number ?? 1,
          filename: activeVersionFilename,
          file_type: (srcV.file_type as string | null) ?? doc.file_type,
          size_bytes:
            (srcV.size_bytes as number | null) ?? doc.size_bytes ?? null,
          page_count:
            (srcV.page_count as number | null) ?? doc.page_count ?? null,
          content_sha256: contentSha256(srcBytes),
        })
        .select("id")
        .single();
      const copyVersionRowId = (newV?.id as string | null) ?? null;
      if (newVError || !copyVersionRowId) {
        throw new Error(
          `Failed to create copied document version: ${newVError?.message ?? "unknown"}`,
        );
      }

      const { data: updatedCopy, error: updateCopyError } = await db
        .from("documents")
        .update({
          current_version_id: copyVersionRowId,
        })
        .eq("id", copy.id)
        .select("*")
        .single();
      if (updateCopyError || !updatedCopy) {
        throw new Error(
          `Failed to activate copied document version: ${updateCopyError?.message ?? "unknown"}`,
        );
      }

      await attachActiveVersionPaths(
        db,
        [updatedCopy as { id: string; current_version_id?: string | null }],
      );
      return { ok: true, status: 201, doc: updatedCopy };
    } catch (err) {
      console.error("[projects/documents/copy] failed", err);
      await Promise.all([
        deleteFile(newKey).catch(() => {}),
        newPdfPath && newPdfPath !== newKey
          ? deleteFile(newPdfPath).catch(() => {})
          : Promise.resolve(),
        db.from("documents").delete().eq("id", copy.id),
      ]);
      return { ok: false, kind: "copy_failed" };
    }
  }
}

export type RenameDocumentResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "doc_not_found" }
  | { ok: false; kind: "db_error"; detail: string }
  | { ok: false; kind: "validation"; detail: string };

export async function renameProjectDocument(
  db: Db,
  args: {
    projectId: string;
    documentId: string;
    userId: string;
    userEmail?: string;
    filename: unknown;
  },
): Promise<RenameDocumentResult> {
  const { projectId, documentId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();
  if (!doc) return { ok: false, kind: "doc_not_found" };
  // The name being renamed lives on the active version row, so a document
  // without one has nothing to rename.
  if (!doc.current_version_id) return { ok: false, kind: "doc_not_found" };

  const active = await db
    .from("document_versions")
    .select("filename")
    .eq("id", doc.current_version_id)
    .eq("document_id", documentId)
    .single();
  const currentName =
    typeof active.data?.filename === "string" && active.data.filename.trim()
      ? active.data.filename.trim()
      : "Untitled document";
  const filename = normalizeDocumentFilename(args.filename, currentName);
  if (!filename)
    return { ok: false, kind: "validation", detail: "filename is required" };

  const { data: updated, error } = await db
    .from("documents")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("project_id", projectId)
    .select("*")
    .single();
  if (error || !updated) return { ok: false, kind: "doc_not_found" };

  // Read the stored name back instead of echoing the requested one — a failed
  // version update used to be swallowed here and the response still claimed
  // the rename had happened.
  const { data: renamed, error: renameError } = await db
    .from("document_versions")
    .update({ filename })
    .eq("id", doc.current_version_id)
    .eq("document_id", documentId)
    .select("filename")
    .single();
  if (renameError)
    return { ok: false, kind: "db_error", detail: renameError.message };
  if (!renamed) return { ok: false, kind: "doc_not_found" };

  return {
    ok: true,
    doc: {
      ...updated,
      filename: renamed.filename,
    },
  };
}

// Gate for POST /projects/:projectId/documents. When the request names a
// target folder, that folder is resolved here too — an upload aimed at a
// folder of another project (or a deleted one) must 404 before any bytes are
// stored, not silently land at the project root.
export async function ensureProjectUploadAccess(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    folderId?: string | null;
  },
): Promise<
  | { ok: true }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "folder_not_found" }
> {
  const { projectId, userId, userEmail, folderId } = args;
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };
  if (folderId) {
    const folder = await loadProjectFolder(db, projectId, folderId);
    if (!folder) return { ok: false, kind: "folder_not_found" };
  }
  return { ok: true };
}
