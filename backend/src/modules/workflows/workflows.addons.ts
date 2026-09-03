// Business logic + data access for the workflow ADD-ON CATALOG — the
// read-only `mike_workflows` rows (distribution = "addon") a user can browse
// and import into their own `workflows` table.
//
// This is a topic file of the workflows module: it takes an explicit `Db`,
// returns typed `ServiceResult`s, and never imports express or touches
// req/res. The thin handlers in workflowAddons.routes.ts map the results onto
// status codes. Its functions are re-exported by name from
// workflows.service.ts, the module facade.

import crypto from "crypto";
import type { Db } from "../../lib/supabase";
import { downloadFile, storageKey, uploadFile } from "../../lib/storage";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import {
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../../lib/documentTypes";
import { contentSha256 } from "../../lib/documentVersions";
import { convertedPdfKey } from "../../lib/convert";
import {
  loadDocumentDisplay,
  prepareDocumentDisplay,
  type DocumentDisplayPayload,
} from "../../lib/documentDisplay";
import {
  failure,
  internalFailure,
  ok,
  type ServiceFailure,
  type ServiceResult,
} from "../../lib/serviceResult";

// The catalog columns the list endpoint projects. Kept as one string so the
// select list stays byte-identical to the pre-move query.
const ADDON_LIST_COLUMNS =
  "id, workflow_key, pack_key, pack_title, pack_description, pack_version, version, title, description, type, contributors, language, practice, jurisdictions, active, updated_at";

type AddonAssetRow = {
  id: string;
  mike_workflow_id: string;
  filename: string;
  file_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

/** A catalog row as sent to the client: `workflow_key` renamed to `addon_key`. */
export type WorkflowAddonSummary = Record<string, unknown>;

/**
 * List the active add-on catalog, optionally narrowed to one workflow type,
 * with each assistant add-on's assets attached.
 */
export async function listWorkflowAddons(
  db: Db,
  params: { type: string | null },
): Promise<ServiceResult<WorkflowAddonSummary[]>> {
  let query = db
    .from("mike_workflows")
    .select(ADDON_LIST_COLUMNS)
    .eq("distribution", "addon")
    .eq("active", true);
  if (params.type === "assistant" || params.type === "tabular")
    query = query.eq("type", params.type);
  const { data, error } = await query.order("title", { ascending: true });
  if (error) return internalFailure(error);
  const addons = (data ?? []) as Record<string, unknown>[];
  const assistantIds = addons
    .filter((addon) => addon.type === "assistant")
    .map((addon) => addon.id as string);
  const { data: assets, error: assetsError } =
    assistantIds.length > 0
      ? await db
          .from("mike_workflow_assets")
          .select(
            "id, mike_workflow_id, filename, file_type, size_bytes, created_at",
          )
          .in("mike_workflow_id", assistantIds)
          .order("created_at", { ascending: true })
      : { data: [] as AddonAssetRow[], error: null };
  if (assetsError) return internalFailure(assetsError);
  const assetsByAddon = new Map<string, AddonAssetRow[]>();
  for (const asset of (assets ?? []) as AddonAssetRow[]) {
    const current = assetsByAddon.get(asset.mike_workflow_id) ?? [];
    current.push(asset);
    assetsByAddon.set(asset.mike_workflow_id, current);
  }
  return ok(
    addons.map(({ workflow_key, ...addon }) => ({
      ...addon,
      addon_key: workflow_key,
      assets: (assetsByAddon.get(addon.id as string) ?? []).map(
        ({ mike_workflow_id: _workflowId, ...asset }) => asset,
      ),
    })),
  );
}

/**
 * Resolve the display bytes for one asset of an assistant add-on. The caller
 * streams the payload; a missing add-on, asset, or object is a 404.
 */
export async function loadWorkflowAddonAssetDisplay(
  db: Db,
  params: { addonId: string; assetId: string },
): Promise<ServiceResult<DocumentDisplayPayload>> {
  const { data: addon, error: addonError } = await db
    .from("mike_workflows")
    .select("id, type")
    .eq("id", params.addonId)
    .eq("distribution", "addon")
    .eq("active", true)
    .maybeSingle();
  if (addonError) return internalFailure(addonError);
  if (!addon || addon.type !== "assistant") {
    return failure("not_found", "Add-on not found");
  }

  const { data: asset, error: assetError } = await db
    .from("mike_workflow_assets")
    .select("id, filename, file_type, storage_path")
    .eq("id", params.assetId)
    .eq("mike_workflow_id", addon.id)
    .maybeSingle();
  if (assetError) return internalFailure(assetError);
  if (!asset) {
    return failure("not_found", "Asset not found");
  }

  try {
    const display = await loadDocumentDisplay({
      filename: asset.filename,
      fileType: asset.file_type,
      storagePath: asset.storage_path,
    });
    if (!display) {
      return failure("not_found", "Asset not found in storage");
    }
    return ok(display);
  } catch (error) {
    return internalFailure(error);
  }
}

/** One catalog row in full, with its assistant assets attached. */
export async function getWorkflowAddon(
  db: Db,
  params: { addonId: string },
): Promise<ServiceResult<Record<string, unknown>>> {
  const { data, error } = await db
    .from("mike_workflows")
    .select("*")
    .eq("id", params.addonId)
    .eq("distribution", "addon")
    .eq("active", true)
    .maybeSingle();
  if (error || !data) {
    return failure("not_found", "Add-on not found");
  }
  let assets = null;
  if (data.type === "assistant") {
    const { data: assistantAssets, error: assetsError } = await db
      .from("mike_workflow_assets")
      .select("id, filename, file_type, size_bytes, created_at")
      .eq("mike_workflow_id", data.id)
      .order("created_at", { ascending: true });
    if (assetsError) {
      return internalFailure(assetsError);
    }
    assets = assistantAssets;
  }
  const { workflow_key, ...addon } = data;
  return ok({
    ...addon,
    addon_key: workflow_key,
    assets: assets ?? [],
  });
}

/** The workflow payload returned to the client after a successful import. */
export type ImportedWorkflow = {
  id: string;
  user_id: string;
  metadata: {
    title: string;
    description: null;
    type: string;
    contributors: never[];
    language: string;
    version: null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: unknown;
  is_system: false;
  is_owner: true;
  allow_edit: true;
  created_at: string;
};

// Copying the add-on's assets can fail after the workflow row exists. That
// path is its own failure kind because it answers 500 with a SPECIFIC detail
// ("Failed to copy add-on assets") rather than the opaque internal-error body
// `sendServiceFailure` produces for kind "error".
export type WorkflowAddonImportFailure =
  | ServiceFailure
  | { ok: false; kind: "assets_copy_failed"; detail: string };

export type ImportWorkflowAddonResult =
  | { ok: true; data: ImportedWorkflow }
  | WorkflowAddonImportFailure;

/**
 * Copy a catalog add-on into the caller's own workflows, duplicating any
 * assistant assets into their document library.
 */
export async function importWorkflowAddon(
  db: Db,
  params: { addonId: string; userId: string },
): Promise<ImportWorkflowAddonResult> {
  const { userId } = params;
  const { data: addon } = await db
    .from("mike_workflows")
    .select("*")
    .eq("id", params.addonId)
    .eq("distribution", "addon")
    .eq("active", true)
    .maybeSingle();
  if (!addon) return failure("not_found", "Add-on not found");

  const { data: workflow, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      title: addon.title,
      type: addon.type,
      prompt_md: addon.prompt_md,
      columns_config: addon.columns_config,
      // Catalog rows may omit these; fall back to the workflows
      // column defaults rather than inserting explicit nulls.
      language: addon.language ?? "English",
      practice: addon.practice ?? "General Transactions",
      jurisdictions: addon.jurisdictions ?? ["General"],
    })
    .select("*")
    .single();
  if (error || !workflow) {
    return internalFailure(
      error ?? new Error("Workflow add-on import returned no data"),
    );
  }

  const createdStoragePaths: string[] = [];
  try {
    const { data: assets, error: assetsError } =
      addon.type === "assistant"
        ? await db
            .from("mike_workflow_assets")
            .select("filename, file_type, storage_path, size_bytes")
            .eq("mike_workflow_id", addon.id)
            .order("created_at", { ascending: true })
        : { data: [], error: null };
    if (assetsError) throw assetsError;
    for (const asset of assets ?? []) {
      const bytes = await downloadFile(asset.storage_path);
      if (!bytes) throw new Error(`Asset '${asset.filename}' is unavailable`);
      const documentId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const contentHash = contentSha256(bytes);
      const sourcePath = storageKey(userId, documentId, asset.filename);
      await uploadFile(
        sourcePath,
        bytes,
        contentTypeForDocumentType(asset.file_type),
      );
      createdStoragePaths.push(sourcePath);
      let pdfStoragePath: string | null = null;
      if (shouldConvertToPdf(asset.file_type)) {
        const display = await prepareDocumentDisplay({
          filename: asset.filename,
          fileType: asset.file_type,
          sourceBytes: bytes,
        });
        pdfStoragePath = convertedPdfKey(userId, documentId);
        await uploadFile(
          pdfStoragePath,
          display.bytes.buffer.slice(
            display.bytes.byteOffset,
            display.bytes.byteOffset + display.bytes.byteLength,
          ) as ArrayBuffer,
          display.contentType,
        );
        createdStoragePaths.push(pdfStoragePath);
      }
      const { error: documentError } = await db.from("documents").insert({
        id: documentId,
        workflow_id: workflow.id,
        user_id: userId,
        status: "processing",
        library_kind: "workflow_asset",
      });
      if (documentError) throw documentError;
      const { error: versionError } = await db
        .from("document_versions")
        .insert({
          id: versionId,
          document_id: documentId,
          storage_path: sourcePath,
          pdf_storage_path: pdfStoragePath,
          source: "upload",
          version_number: 1,
          filename: asset.filename,
          file_type: asset.file_type,
          size_bytes: asset.size_bytes ?? bytes.byteLength,
          content_sha256: contentHash,
        });
      if (versionError) throw versionError;
      const { error: readyError } = await db
        .from("documents")
        .update({
          current_version_id: versionId,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (readyError) throw readyError;
    }
  } catch {
    // Rollback order matters: drop the workflow row first, so nothing can
    // reference the half-made copies, then hand the object deletes to the
    // durable storage.cleanup job. A Promise.all of best-effort
    // deletes died with the request — a restart mid-loop, or a single
    // storage error, leaked every copy made so far with no row left
    // pointing at them. The job retries until they are actually gone.
    await db
      .from("workflows")
      .delete()
      .eq("id", workflow.id)
      .eq("user_id", userId);
    await enqueueStorageCleanup(db, createdStoragePaths);
    return {
      ok: false,
      kind: "assets_copy_failed",
      detail: "Failed to copy add-on assets",
    };
  }

  return ok({
    id: workflow.id,
    user_id: workflow.user_id,
    metadata: {
      title: workflow.title,
      description: null,
      type: workflow.type,
      contributors: [],
      language: workflow.language ?? "English",
      version: null,
      practice: workflow.practice ?? null,
      jurisdictions: workflow.jurisdictions ?? null,
    },
    skill_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
    is_system: false,
    is_owner: true,
    allow_edit: true,
    created_at: workflow.created_at,
  });
}
