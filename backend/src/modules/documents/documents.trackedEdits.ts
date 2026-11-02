// Tracked-change edits to a stored .docx: the edits become a new, active
// document version with one document_edits row per change, which the user
// later accepts or rejects. The assistant's edit_document tool and playbook
// reviews both write through here, so version creation stays in this module.

import crypto from "node:crypto";
import type { EditAnnotation } from "@mike/contracts";
import { can, ensureDocAccess } from "../../lib/access";
import { applyTrackedEdits, type EditInput } from "../../lib/docxTrackedChanges";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { buildDownloadUrl } from "../../lib/downloadTokens";
import { deleteFileBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import { reportError } from "../../lib/observability/sentry";
import type { Db } from "../../lib/supabase";
import { profileAttributionName } from "../../lib/userLookup";
import {
  activateDocumentVersion,
  createDocumentVersion,
  updateDocumentVersion,
} from "./documents.lifecycle";

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
  documentId: string,
  db: Db,
  versionId?: string | null,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
  const active = await loadActiveVersion(documentId, db, versionId);
  if (!active) return null;
  const raw = await downloadFile(active.storage_path);
  if (!raw) return null;
  return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

export async function applyTrackedEditsToDocument(params: {
  documentId: string;
  userId: string;
  /**
   * The caller's authenticated email, needed to resolve direct (email-keyed)
   * grants in the write check below. Without it only creator and
   * organization access count, which fails closed.
   */
  userEmail?: string | null;
  edits: EditInput[];
  db: Db;
  /** A long-running review must not apply suggestions to a newer document. */
  expectedVersion?: { id: string; storagePath: string };
  /**
   * If provided, append these edits to the existing turn-scoped version
   * (overwrites the file at storagePath and reuses the document_versions
   * row) instead of creating a new version. Used to collapse multiple
   * edit_document tool calls within a single assistant turn into one
   * version.
   */
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
}): Promise<
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      annotations: EditAnnotation[];
      errors: { index: number; reason: string }[];
    }
  | { ok: false; error: string }
> {
  const { documentId, userId, userEmail, edits, db, reuseVersion } = params;

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Document not found." };

  // The write is authorized against THIS document, not the turn. Whether a
  // turn may write at all (`allowDocumentMutation`) is decided from the
  // chat's container, but the chat's attachments can come from anywhere the
  // caller can read — a standalone chat, or a project chat that attached a
  // document from another project. Reading is not editing: a Viewer on the
  // document's project must not get a new active version through the
  // assistant when the version routes would refuse them.
  const access = await ensureDocAccess(
    doc as {
      user_id: string | null;
      project_id: string | null;
      org_id?: string | null;
      workflow_id?: string | null;
    },
    userId,
    userEmail,
    db,
  );
  if (!access.ok) return { ok: false, error: "Document not found." };
  if (!can(access.projectRole, "content.edit"))
    return {
      ok: false,
      error:
        "You do not have permission to edit this document. Use replicate_document to make an editable copy instead.",
    };

  const activeVersion = await loadActiveVersion(documentId, db);
  if (params.expectedVersion && (
    activeVersion?.id !== params.expectedVersion.id ||
    activeVersion.storage_path !== params.expectedVersion.storagePath
  )) {
    return { ok: false, error: "This document changed. Run the review again before applying its suggestions." };
  }
  let versionFilename =
    activeVersion?.filename?.trim() || "Untitled document";

  let raw: ArrayBuffer | null;
  try {
    raw = activeVersion ? await downloadFile(activeVersion.storage_path) : null;
  } catch (error) {
    reportError(error, { tags: { component: "documents", operation: "documents.edit" } });
    return { ok: false, error: "Could not load document bytes." };
  }
  if (!raw || !activeVersion) return { ok: false, error: "Could not load document bytes." };
  const current = { bytes: Buffer.from(raw), storage_path: activeVersion.storage_path };

  const { data: authorProfile } = await db
    .from("user_profiles")
    .select("display_name, email")
    .eq("user_id", userId)
    .maybeSingle();
  const author = profileAttributionName(authorProfile, "Mike");

  const {
    bytes: editedBytes,
    changes,
    errors,
  } = await applyTrackedEdits(current.bytes, edits, { author });

  if (changes.length === 0) {
    return {
      ok: false,
      error:
        errors[0]?.reason ??
        "No edits could be applied. Refine context_before/context_after and retry.",
    };
  }

  const ab = editedBytes.buffer.slice(
    editedBytes.byteOffset,
    editedBytes.byteOffset + editedBytes.byteLength,
  ) as ArrayBuffer;

  let versionRowId: string;
  let newPath: string;
  let nextVersionNumber: number;

  if (reuseVersion) {
    // Reuse the version number, but never overwrite bytes an extraction job
    // may be reading. Publish the new path/hash together after storage succeeds.
    if (activeVersion?.id !== reuseVersion.versionId || current.storage_path !== reuseVersion.storagePath) {
      return { ok: false, error: "This document changed. Read the latest version and try again." };
    }
    newPath = `documents/${userId}/${documentId}/edits/${crypto.randomUUID().replace(/-/g, "")}.docx`;
    versionRowId = reuseVersion.versionId;
    nextVersionNumber = reuseVersion.versionNumber;

    await uploadFile(newPath, ab, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const updated = await updateDocumentVersion(db, documentId, versionRowId, {
      storage_path: newPath,
      file_type: "docx", size_bytes: editedBytes.byteLength, page_count: null,
      content_sha256: contentSha256(editedBytes), pdf_storage_path: null,
    }, { expectedStoragePath: reuseVersion.storagePath });
    if (updated.error || !updated.data) {
      // A transport/database error may arrive after the update committed. Only
      // an acknowledged no-row result proves this new object is unreferenced;
      // deleting it on an ambiguous failure could destroy the saved document.
      if (!updated.error) await deleteFileBestEffort(newPath, "assistant-edit-conflict");
      return { ok: false, error: "Failed to update document version. Read the latest version and try again." };
    }
  } else {
    const versionId = crypto.randomUUID().replace(/-/g, "");
    newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
    await uploadFile(
      newPath,
      ab,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Inherit the filename from the most recent prior version so
    // user-applied renames carry forward through further edits. Malformed
    // legacy rows without a filename get a neutral placeholder, not the
    // parent document filename. We intentionally do NOT append "[Edited Vn]"
    // — the version number is surfaced separately as a tag in the UI.
    const { data: prevRow } = await db
      .from("document_versions")
      .select("filename, created_at")
      .eq("document_id", documentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const inheritedFilename =
      (prevRow?.filename as string | null)?.trim() || "Untitled document";
    versionFilename = inheritedFilename;

    const { data: versionRow, error: verErr } = await createDocumentVersion(db, {
        document_id: documentId,
        storage_path: newPath,
        source: "assistant_edit",

        filename: inheritedFilename,
        file_type: "docx",
        size_bytes: editedBytes.byteLength,
        page_count: null,
        content_sha256: contentSha256(editedBytes),
      }, { activate: false });
    if (verErr || !versionRow) {
      return { ok: false, error: "Failed to record document version." };
    }
    versionRowId = versionRow.id as string;
    nextVersionNumber = versionRow.version_number;
  }

  // Insert one row per change
  const editRows = changes.map((c) => ({
    document_id: documentId,
    version_id: versionRowId,
    change_id: c.id,
    del_w_id: c.delId ?? null,
    ins_w_id: c.insId ?? null,
    deleted_text: c.deletedText,
    inserted_text: c.insertedText,
    context_before: c.contextBefore ?? "",
    context_after: c.contextAfter ?? "",
    status: "pending" as const,
  }));
  const { data: insertedEdits, error: editsErr } = await db
    .from("document_edits")
    .insert(editRows)
    .select(
      "id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after",
    );

  if (editsErr || !insertedEdits) {
    return { ok: false, error: "Failed to record edits." };
  }

  const activation = await activateDocumentVersion(db, documentId, versionRowId);
  if (activation.error || !activation.activated) {
    return { ok: false, error: "Failed to activate document version." };
  }

  const annotations: EditAnnotation[] = insertedEdits.map(
    (r: {
      id: string;
      change_id: string;
      deleted_text: string;
      inserted_text: string;
      context_before: string | null;
      context_after: string | null;
    }) => {
      const src = changes.find((c) => c.id === r.change_id);
      return {
        kind: "edit",
        edit_id: r.id,
        document_id: documentId,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        change_id: r.change_id,
        del_w_id: src?.delId,
        ins_w_id: src?.insId,
        deleted_text: r.deleted_text ?? "",
        inserted_text: r.inserted_text ?? "",
        context_before: r.context_before ?? "",
        context_after: r.context_after ?? "",
        reason: src?.reason,
        status: "pending",
      };
    },
  );

  // Persistent, non-expiring permalink. The backend streams fresh bytes
  // on each request, so this URL stays valid as long as the file exists.
  const resolvedFilename = versionFilename.trim() || "Untitled document.docx";
  const permalink = buildDownloadUrl(newPath, resolvedFilename);

  return {
    ok: true,
    version_id: versionRowId,
    version_number: nextVersionNumber,
    storage_path: newPath,
    download_url: permalink,
    annotations,
    errors,
  };
}
