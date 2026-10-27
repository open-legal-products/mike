import { ensureDocAccess } from "../access";
import { isVisualDocumentType } from "../documentTypes";
import { downloadFilenameForVersion, loadActiveVersion } from "../documentVersions";
import type { ProjectRole } from "../permissions";
import { getSandbox, type RenderFailureCode, type VisualBlock } from "../sandbox";
import { failure, internalFailure, ok, type ServiceFailure, type ServiceResult } from "../serviceResult";
import { downloadFile } from "../storage";
import type { Db } from "../supabase";
import { composeVisualDocument } from "./compose";
import { parseStoredVisual, type VisualSource } from "./source";

export type VisualTarget = {
  documentId: string;
  versionId: string | null;
  userId: string;
  userEmail?: string | null;
};

type LoadedVisual = {
  source: VisualSource;
  filename: string;
  projectId: string | null;
  orgId: string | null;
  projectRole: ProjectRole;
  isCreator: boolean;
};

/** The stored visual behind a document the caller may read. */
export async function loadVisual(db: Db, target: VisualTarget): Promise<ServiceResult<LoadedVisual>> {
  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", target.documentId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!doc) return failure("not_found", "Document not found");
  const access = await ensureDocAccess(doc, target.userId, target.userEmail, db);
  if (!access.ok) return failure("not_found", "Document not found");
  const version = await loadActiveVersion(target.documentId, db, target.versionId);
  if (!version) return failure("not_found", "No file available");
  if (!isVisualDocumentType(version.file_type)) {
    return failure("validation", "This document is not a visual.", "not_a_visual");
  }
  const stored = await downloadFile(version.storage_path);
  if (!stored) return failure("not_found", "Document bytes not available");
  return ok({
    source: await parseStoredVisual(stored),
    filename: downloadFilenameForVersion(version.filename, version.version_number, version.source === "assistant_edit"),
    projectId: (doc.project_id as string | null) ?? null,
    orgId: (doc.org_id as string | null) ?? null,
    projectRole: access.projectRole,
    isCreator: access.isCreator,
  });
}

const RENDER_FAILURES: Record<RenderFailureCode, ServiceFailure> = {
  render_unavailable: failure("unavailable", "Exporting visuals is not available on this server.", "render_unavailable"),
  render_busy: failure("unavailable", "The renderer is busy. Please try again in a moment.", "render_busy"),
  render_timeout: failure("unavailable", "The visual took too long to render.", "render_timeout"),
  render_failed: failure("validation", "The visual could not be rendered.", "render_failed"),
};

export type ExportedVisual = { bytes: Buffer; filename: string };

export async function exportVisual(db: Db, target: VisualTarget): Promise<ServiceResult<ExportedVisual>> {
  const loaded = await loadVisual(db, target);
  if (!loaded.ok) return loaded;
  const html = composeVisualDocument(loaded.data.source, { mode: "export" });
  const rendered = await getSandbox().render({ html, format: "pdf" });
  if (!rendered.ok) return RENDER_FAILURES[rendered.code];
  return ok({ bytes: rendered.bytes, filename: loaded.data.filename.replace(/\.html$/i, "") + ".pdf" });
}

export type RenderedVisualBlocks = { blocks: VisualBlock[] };

/** The visual read as Word blocks: its text, tables and pictures in order. */
export async function renderLoadedVisualBlocks(loaded: LoadedVisual): Promise<ServiceResult<RenderedVisualBlocks>> {
  const html = composeVisualDocument(loaded.source, { mode: "export" });
  const rendered = await getSandbox().render({ html, format: "blocks" });
  if (!rendered.ok) return RENDER_FAILURES[rendered.code];
  return ok({ blocks: rendered.blocks });
}

export async function renderVisualBlocksForDocument(db: Db, target: VisualTarget): Promise<ServiceResult<RenderedVisualBlocks>> {
  const loaded = await loadVisual(db, target);
  return loaded.ok ? renderLoadedVisualBlocks(loaded.data) : loaded;
}
