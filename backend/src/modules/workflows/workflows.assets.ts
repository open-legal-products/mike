import { captureInlineDocumentCleanup, completeInlineDocumentCleanup, createDocumentVersion, copyDocumentVersionFiles } from "../documents/documents.service";

// workflows assets — implementation behind the module facade.
// Business logic + data access for the workflows module.
//
// These functions take an explicit Supabase client (`db`) plus
// request-derived primitives, perform the workflow / share / hidden-list /
// asset orchestration, and RETURN typed results. They never touch
// req/res — the thin route handlers in workflows.routes.ts map the results
// onto HTTP status codes and response bodies.
import { randomUUID } from "node:crypto";
import { type Db } from "../../lib/supabase";
import { ensureDocAccess } from "../../lib/access";
import { convertedPdfKey } from "../../lib/convert";
import { copyFile, storageKey } from "../../lib/storage";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import { attachActiveVersionPaths, attachLatestVersionNumbers } from "../../lib/documentVersions";
import { resolveWorkflowAccess, assetsUnsupported } from "./workflows.access";

// --- Assets (assistant workflows only) -------------------------------------
//
// Workflow assets are ordinary `documents` rows tagged with the owning
// workflow plus `library_kind: "workflow_asset"`. They are created by copying
// an already-accessible document's current version rather than by uploading
// bytes, so every source document is authorization-checked individually.

const MAX_WORKFLOW_ASSET_SOURCES = 50;

export type WorkflowAssetFailure =
  | { ok: false; kind: "workflow_not_found" }
  | { ok: false; kind: "not_editable" }
  | { ok: false; kind: "tabular_unsupported" }
  | { ok: false; kind: "asset_not_found" }
  | { ok: false; kind: "documents_not_found" }
  | { ok: false; kind: "documents_not_ready" }
  | { ok: false; kind: "db_error"; error: unknown };

type WorkflowAssetRow = {
  id: string;
  current_version_id?: string | null;
  latest_version_number?: number | null;
  [key: string]: unknown;
};

// Parses a request body's `document_ids` selection. Returns null when it is
// missing, not an array, empty, over the cap, or carries duplicate/blank
// entries — the route answers 400 for every one of those cases.
export function parseAssetDocumentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const documentIds = [
    ...new Set(
      value.filter(
        (documentId: unknown): documentId is string =>
          typeof documentId === "string" && documentId.trim().length > 0,
      ),
    ),
  ];
  if (
    documentIds.length === 0 ||
    documentIds.length > MAX_WORKFLOW_ASSET_SOURCES ||
    documentIds.length !== value.length
  ) {
    return null;
  }
  return documentIds;
}

export async function listWorkflowAssets(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<{ ok: true; assets: WorkflowAssetRow[] } | WorkflowAssetFailure> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false, kind: "workflow_not_found" };
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }

  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, kind: "db_error", error };
  const assets = (data ?? []) as WorkflowAssetRow[];
  await attachLatestVersionNumbers(db, assets);
  await attachActiveVersionPaths(db, assets);
  return { ok: true, assets };
}

export async function copyDocumentsToWorkflowAssets(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    documentIds: string[];
  },
): Promise<{ ok: true; assets: unknown[] } | WorkflowAssetFailure> {
  const { workflowId, userId, userEmail, documentIds } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }

  const { data: sourceDocuments, error: documentsError } = await db
    .from("documents")
    .select("id, user_id, project_id, workflow_id, current_version_id")
    .in("id", documentIds);
  if (documentsError) {
    return { ok: false, kind: "db_error", error: documentsError };
  }
  if (!sourceDocuments || sourceDocuments.length !== documentIds.length) {
    return { ok: false, kind: "documents_not_found" };
  }

  // Edit rights on the workflow never stand in for access to the files being
  // copied: each source document is checked on its own.
  const accessResults = await Promise.all(
    sourceDocuments.map((document) =>
      ensureDocAccess(document, userId, userEmail, db),
    ),
  );
  if (accessResults.some((result) => !result.ok)) {
    return { ok: false, kind: "documents_not_found" };
  }

  const versionIds = sourceDocuments.flatMap((document) =>
    document.current_version_id ? [document.current_version_id] : [],
  );
  if (versionIds.length !== documentIds.length) {
    return { ok: false, kind: "documents_not_ready" };
  }
  const { data: sourceVersions, error: versionsError } = await db
    .from("document_versions")
    .select(
      "id, document_id, storage_path, pdf_storage_path, filename, file_type, size_bytes, page_count, content_sha256",
    )
    .in("id", versionIds)
    .is("deleted_at", null);
  if (versionsError) {
    return { ok: false, kind: "db_error", error: versionsError };
  }
  if (
    !sourceVersions ||
    sourceVersions.length !== documentIds.length ||
    sourceVersions.some((version) => !version.storage_path || !version.filename)
  ) {
    return { ok: false, kind: "documents_not_ready" };
  }

  const sourceDocumentById = new Map(
    sourceDocuments.map((document) => [document.id, document]),
  );
  const sourceVersionById = new Map(
    sourceVersions.map((version) => [version.id, version]),
  );
  if (
    sourceDocuments.some(
      (document) =>
        sourceVersionById.get(document.current_version_id)?.document_id !==
        document.id,
    )
  ) {
    return { ok: false, kind: "documents_not_ready" };
  }
  const plans = documentIds.map((sourceDocumentId) => {
    const sourceDocument = sourceDocumentById.get(sourceDocumentId)!;
    const sourceVersion = sourceVersionById.get(
      sourceDocument.current_version_id,
    )!;
    const documentId = randomUUID();
    const versionId = randomUUID();
    const sourcePath = storageKey(userId, documentId, sourceVersion.filename);
    const pdfPath = sourceVersion.pdf_storage_path
      ? sourceVersion.pdf_storage_path === sourceVersion.storage_path
        ? sourcePath
        : convertedPdfKey(userId, documentId)
      : null;
    return {
      documentId,
      versionId,
      sourceVersion,
      sourcePath,
      pdfPath,
    };
  });
  const copiedPaths = new Set<string>();

  try {
    for (const plan of plans) {
      await copyDocumentVersionFiles({
        source: plan.sourceVersion, storagePath: plan.sourcePath,
        pdfStoragePath: plan.pdfPath ?? plan.sourcePath,
        transport: "server", rendition: "required",
        beforeWrite: (key) => { copiedPaths.add(key); },
      });
    }

    const { error: insertDocumentsError } = await db.from("documents").insert(
      plans.map((plan) => ({
        id: plan.documentId,
        project_id: null,
        user_id: userId,
        status: "ready",
        folder_id: null,
        library_kind: "workflow_asset",
        library_folder_id: null,
        workflow_id: workflowId,
      })),
    );
    if (insertDocumentsError) throw insertDocumentsError;

    for (const plan of plans) {
      const { error } = await createDocumentVersion(db, {
          id: plan.versionId,
          document_id: plan.documentId,
          storage_path: plan.sourcePath,
          pdf_storage_path: plan.pdfPath,
          source: "upload",
          version_number: 1,
          filename: plan.sourceVersion.filename,
          file_type: plan.sourceVersion.file_type,
          size_bytes: plan.sourceVersion.size_bytes,
          page_count: plan.sourceVersion.page_count,
          content_sha256: plan.sourceVersion.content_sha256,
        });
      if (error) throw error;
    }

    const createdIds = plans.map((plan) => plan.documentId);
    const { data: createdDocuments, error: createdDocumentsError } = await db
      .from("documents")
      .select("*")
      .in("id", createdIds);
    if (
      createdDocumentsError ||
      !createdDocuments ||
      createdDocuments.length !== createdIds.length
    ) {
      throw (
        createdDocumentsError ??
        new Error("Workflow asset copy returned no documents")
      );
    }
    await attachLatestVersionNumbers(db, createdDocuments);
    await attachActiveVersionPaths(db, createdDocuments);
    const createdById = new Map(
      createdDocuments.map((document) => [document.id, document]),
    );
    return { ok: true, assets: createdIds.map((id) => createdById.get(id)) };
  } catch (error) {
    // Roll the whole copy back durably: orphaned rows go first, then the
    // objects already copied are handed to the storage.cleanup queue.
    const createdIds = plans.map((plan) => plan.documentId);
    await db.from("documents").delete().in("id", createdIds);
    await enqueueStorageCleanup(db, [...copiedPaths]);
    return { ok: false, kind: "db_error", error };
  }
}

export async function deleteWorkflowAsset(
  db: Db,
  params: {
    workflowId: string;
    assetId: string;
    userId: string;
    userEmail: string | undefined;
  },
): Promise<{ ok: true } | WorkflowAssetFailure> {
  const { workflowId, assetId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  if (assetsUnsupported(access)) {
    return { ok: false, kind: "tabular_unsupported" };
  }
  const { data: asset } = await db
    .from("documents")
    .select("id")
    .eq("id", assetId)
    .eq("workflow_id", workflowId)
    .maybeSingle();
  if (!asset) return { ok: false, kind: "asset_not_found" };
  const keys = await captureInlineDocumentCleanup(db, { documentIds: [asset.id] });
  const { error } = await db
    .from("documents")
    .delete()
    .eq("id", asset.id)
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, kind: "db_error", error };
  await completeInlineDocumentCleanup(db, keys);
  return { ok: true };
}
