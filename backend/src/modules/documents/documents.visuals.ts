// A new version of an assistant-made visual. edit_visual writes through here,
// so version creation for visuals stays in this module like tracked edits.

import { randomUUID } from "node:crypto";
import { can, ensureDocAccess } from "../../lib/access";
import { isVisualDocumentType } from "../../lib/documentTypes";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { uploadFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import { createDocumentVersion } from "./documents.lifecycle";

export type SavedVisualVersion = {
  version_id: string;
  version_number: number;
  storage_path: string;
  filename: string;
};

export async function saveVisualVersion(
  db: Db,
  params: {
    documentId: string;
    userId: string;
    userEmail?: string | null;
    bytes: Buffer;
  },
): Promise<ServiceResult<SavedVisualVersion>> {
  const { documentId, userId, userEmail, bytes } = params;
  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id, library_kind")
    .eq("id", documentId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!doc) return failure("not_found", "Document not found.");
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) return failure("not_found", "Document not found.");
  if (!can(access.projectRole, "content.edit")) {
    return failure("forbidden", "You do not have permission to edit this visual.");
  }
  if (doc.library_kind !== "file") {
    return failure("forbidden", "Templates and workflow assets cannot be edited.");
  }
  const active = await loadActiveVersion(documentId, db);
  if (!active || !isVisualDocumentType(active.file_type)) {
    return failure("validation", "This document is not a visual.", "not_a_visual");
  }
  const filename = active.filename?.trim() || "Visual.html";
  const storagePath = `documents/${userId}/${documentId}/edits/${randomUUID().replace(/-/g, "")}.html`;
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // Stored as a generic binary: a leaked object URL must never render.
  await uploadFile(storagePath, content, "application/octet-stream");
  const created = await createDocumentVersion(db, {
    document_id: documentId,
    storage_path: storagePath,
    source: "assistant_edit",
    filename,
    file_type: "html",
    size_bytes: bytes.byteLength,
    page_count: null,
    content_sha256: contentSha256(bytes),
  });
  const version = created.data;
  if (created.error || !version) return internalFailure(created.error ?? new Error("visual version not recorded"));
  return ok({
    version_id: version.id,
    version_number: version.version_number,
    storage_path: storagePath,
    filename,
  });
}
