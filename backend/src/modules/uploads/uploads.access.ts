// Authorization for an upload session's destination.
//
// A manifest names where its files should land — a standalone document, a
// project folder, a library folder, a workflow asset, or a specific version
// of an existing document. This guard proves the caller may write there
// BEFORE any session row or signed URL exists, so an unauthorized manifest
// never reaches storage.
//
// Every rejection is a 404 unless the caller demonstrably knows the resource:
// a wrong-scope destination must not double as an existence oracle.

import { ensureDocAccess, checkProjectAccess } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import type { ParsedUploadSessionRequest } from "./uploads.manifest";
import {
  failure,
  internalFailure,
  type UploadOutcome,
} from "./uploads.shared";

export async function validateDestinationAccess(
  manifest: ParsedUploadSessionRequest,
  userId: string,
  userEmail: string | undefined,
  db: Db,
): Promise<UploadOutcome> {
  const destination = manifest.destination as Record<string, unknown>;

  if (manifest.purpose === "document_create") {
    if (destination.scope === "standalone") return { ok: true };
    if (destination.scope === "workflow") {
      const workflowId = destination.workflow_id as string;
      const { data: workflow, error } = await db
        .from("workflows")
        .select("id, user_id, type")
        .eq("id", workflowId)
        .maybeSingle();
      if (error) return internalFailure(error);
      if (!workflow || workflow.type !== "assistant") {
        return failure(404, { detail: "Workflow not found or not editable" });
      }
      if (workflow.user_id === userId) return { ok: true };
      const normalizedEmail = (userEmail ?? "").trim().toLowerCase();
      if (!normalizedEmail) {
        return failure(404, { detail: "Workflow not found or not editable" });
      }
      const { data: share, error: shareError } = await db
        .from("workflow_shares")
        .select("allow_edit")
        .eq("workflow_id", workflowId)
        .eq("shared_with_email", normalizedEmail)
        .maybeSingle();
      if (shareError) return internalFailure(shareError);
      if (share?.allow_edit === true) return { ok: true };
      return failure(404, { detail: "Workflow not found or not editable" });
    }
    if (destination.scope === "project") {
      const projectId = destination.project_id as string;
      const access = await checkProjectAccess(projectId, userId, userEmail, db);
      if (!access.ok) return failure(404, { detail: "Project not found" });
      const folderIds = Array.from(
        new Set(
          [
            destination.folder_id as string | null | undefined,
            ...manifest.files.map((file) => file.target_folder_id),
          ].filter((value): value is string => !!value),
        ),
      );
      if (folderIds.length) {
        const { data, error } = await db
          .from("project_subfolders")
          .select("id")
          .eq("project_id", projectId)
          .in("id", folderIds);
        if (error) return internalFailure(error);
        if ((data ?? []).length !== folderIds.length) {
          return failure(404, { detail: "Folder not found" });
        }
      }
      return { ok: true };
    }

    const folderIds = Array.from(
      new Set(
        [
          destination.folder_id as string | null | undefined,
          ...manifest.files.map((file) => file.target_folder_id),
        ].filter((value): value is string => !!value),
      ),
    );
    if (!folderIds.length) return { ok: true };
    const { data, error } = await db
      .from("library_folders")
      .select("id")
      .eq("user_id", userId)
      .eq("library_kind", destination.library_kind as string)
      .in("id", folderIds);
    if (error) return internalFailure(error);
    if ((data ?? []).length !== folderIds.length) {
      return failure(404, { detail: "Folder not found" });
    }
    return { ok: true };
  }

  if (
    manifest.purpose === "document_version_create" ||
    manifest.purpose === "document_version_replace"
  ) {
    const documentId = destination.document_id as string;
    const { data: document, error } = await db
      .from("documents")
      .select("id, user_id, project_id, workflow_id")
      .eq("id", documentId)
      .maybeSingle();
    if (error) return internalFailure(error);
    if (!document) return failure(404, { detail: "Document not found" });
    const access = await ensureDocAccess(document, userId, userEmail, db);
    const canReplace =
      access.ok &&
      (access.isOwner || (Boolean(document.workflow_id) && access.canEdit));
    if (
      !access.ok ||
      !access.canEdit ||
      (manifest.purpose === "document_version_replace" && !canReplace)
    ) {
      return failure(404, { detail: "Document not found" });
    }
    if (manifest.purpose === "document_version_create") return { ok: true };

    const { data: version, error: versionError } = await db
      .from("document_versions")
      .select("id, file_type, deleted_at")
      .eq("id", destination.version_id as string)
      .eq("document_id", documentId)
      .maybeSingle();
    if (versionError) return internalFailure(versionError);
    if (!version || version.deleted_at) {
      return failure(404, { detail: "Version not found" });
    }
    if (
      version.file_type &&
      version.file_type !== manifest.files[0].file_type
    ) {
      return failure(400, {
        detail: `Uploaded file type (${manifest.files[0].file_type}) does not match version type (${version.file_type}).`,
      });
    }
    return { ok: true };
  }

  const workflowId = destination.workflow_id as string;
  const { data: workflow, error } = await db
    .from("workflows")
    .select("id, user_id, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!workflow) {
    return failure(404, { detail: "Workflow not found or not editable" });
  }

  let canEdit = workflow.user_id === userId;
  if (!canEdit && userEmail) {
    const { data: share, error: shareError } = await db
      .from("workflow_shares")
      .select("allow_edit")
      .eq("workflow_id", workflowId)
      .eq("shared_with_email", userEmail.trim().toLowerCase())
      .maybeSingle();
    if (shareError) return internalFailure(shareError);
    canEdit = share?.allow_edit === true;
  }
  if (!canEdit) {
    return failure(404, { detail: "Workflow not found or not editable" });
  }
  if (workflow.type === "tabular") {
    return failure(400, {
      detail: "Assets are only supported for assistant workflows",
    });
  }

  // Compatibility validation for in-flight sessions created by the previous
  // release. New clients use document_version_create.
  if (manifest.purpose === "workflow_reference_replace") {
    const { data: asset, error: assetError } = await db
      .from("documents")
      .select("id")
      .eq("id", destination.reference_id as string)
      .eq("workflow_id", workflowId)
      .maybeSingle();
    if (assetError) return internalFailure(assetError);
    if (!asset) return failure(404, { detail: "Asset not found" });
  }
  return { ok: true };
}
