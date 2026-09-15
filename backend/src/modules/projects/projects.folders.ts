// Project subfolder service functions: create, rename/move (with cycle
// check), recursive delete, and moving documents between folders.

import { parseFolderPath, validateFolderMove, collectFolderSubtree } from "../../lib/folderTree";
import { checkProjectAccess } from "../../lib/access";
import { can } from "../../lib/permissions";
import {
  type Db,
  deleteProjectDocumentsAndVersionFiles,
  loadProjectFolder,
} from "./projects.shared";

export type CreateFolderResult =
  | { ok: true; folder: unknown }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "parent_not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function createProjectFolder(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    name: string;
    parent_folder_id?: string | null;
  },
): Promise<CreateFolderResult> {
  const { projectId, userId, userEmail, name, parent_folder_id } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !can(access.projectRole, "docs.organize"))
    return { ok: false, kind: "forbidden" };

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return { ok: false, kind: "parent_not_found" };
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return { ok: false, kind: "db_error", error };
  return { ok: true, folder: data };
}

export type UpdateFolderResult =
  | { ok: true; folder: unknown }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "parent_not_found" }
  | { ok: false; kind: "cycle" }
  | { ok: false; kind: "not_found" };

export async function updateProjectFolder(
  db: Db,
  args: {
    projectId: string;
    folderId: string;
    userId: string;
    userEmail?: string;
    body: { name?: string; parent_folder_id?: string | null };
  },
): Promise<UpdateFolderResult> {
  const { projectId, folderId, userId, userEmail, body } = args;

  // Re-shaping the folder tree is member work, alongside the documents it
  // holds — Will's review put "organize documents and folders" on one line.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !can(access.projectRole, "docs.organize"))
    return { ok: false, kind: "forbidden" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      const parent = await loadProjectFolder(db, projectId, body.parent_folder_id);
      if (!parent) return { ok: false, kind: "parent_not_found" };

      const moveError = await validateFolderMove(
        folderId, body.parent_folder_id,
        (id) => loadProjectFolder(db, projectId, id),
      );
      if (moveError) return { ok: false, kind: moveError };
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return { ok: false, kind: "not_found" };
  return { ok: true, folder: data };
}

export type DeleteFolderResult =
  | { ok: true }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function deleteProjectFolder(
  db: Db,
  args: {
    projectId: string;
    folderId: string;
    userId: string;
    userEmail?: string;
  },
): Promise<DeleteFolderResult> {
  const { projectId, folderId, userId, userEmail } = args;

  // Folder deletion cascades into every nested document and its storage
  // objects — but so does deleting those documents one at a time, which a
  // member may already do. Gating the folder higher bought no safety, only a
  // confusing extra tier.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !can(access.projectRole, "docs.organize"))
    return { ok: false, kind: "forbidden" };

  const { data: allFolders, error: foldersError } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("project_id", projectId);
  if (foldersError)
    return { ok: false, kind: "db_error", error: foldersError };
  if (!(allFolders ?? []).some((f) => f.id === folderId))
    return { ok: false, kind: "not_found" };

  const folderIds = collectFolderSubtree(folderId, allFolders ?? []);

  const { data: docs, error: docsError } = await db
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .in("folder_id", [...folderIds]);
  if (docsError) return { ok: false, kind: "db_error", error: docsError };

  const docIds = (docs ?? []).map((d) => d.id as string);
  const deleteDocsError = await deleteProjectDocumentsAndVersionFiles(
    db,
    projectId,
    docIds,
  );
  if (deleteDocsError)
    return { ok: false, kind: "db_error", error: deleteDocsError };

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return { ok: false, kind: "db_error", error };
  return { ok: true };
}

export type MoveDocumentResult =
  | { ok: true; doc: unknown }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "folder_not_found" }
  | { ok: false; kind: "doc_not_found" };

export async function moveProjectDocument(
  db: Db,
  args: {
    projectId: string;
    documentId: string;
    userId: string;
    userEmail?: string;
    folder_id: string | null;
  },
): Promise<MoveDocumentResult> {
  const { projectId, documentId, userId, userEmail, folder_id } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !can(access.projectRole, "docs.organize"))
    return { ok: false, kind: "forbidden" };

  if (folder_id) {
    const folder = await loadProjectFolder(db, projectId, folder_id);
    if (!folder) return { ok: false, kind: "folder_not_found" };
  }

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return { ok: false, kind: "doc_not_found" };
  return { ok: true, doc: data };
}

// POST /projects/:projectId/folder-paths/resolve
// Folder uploads arrive as a list of path segments ("Contracts/2026/NDAs").
// Creating those levels one round trip at a time races every other file in
// the same drop, so the whole walk — reuse, rename, or error on a name
// collision — happens inside one RPC. This owns the segment-list validation
// (mirroring library.service's resolveLibraryFolderPath), access, the
// base-folder check, and the RPC.
export type ResolveFolderPathResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "invalid_path" }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "parent_not_found" }
  | { ok: false; kind: "rpc_error" };

export async function resolveProjectFolderPath(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    body: {
      base_folder_id?: string | null;
      segments?: unknown;
      conflict_resolution?: unknown;
    };
  },
): Promise<ResolveFolderPathResult> {
  const { projectId, userId, userEmail, body } = args;

  const path = parseFolderPath(body);
  if (!path) return { ok: false, kind: "invalid_path" };
  const { segments, conflictResolution, baseFolderId } = path;

  // This route reads like a lookup, but resolve_project_folder_path INSERTs
  // a project_subfolders row for every path segment that does not exist
  // yet. It therefore needs the same docs.organize gate its sibling folder
  // routes declare; without it a viewer — whose whole tier is read-only —
  // could POST an arbitrary nested folder tree into someone else's project.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !can(access.projectRole, "docs.organize"))
    return { ok: false, kind: "forbidden" };
  if (baseFolderId) {
    const parent = await loadProjectFolder(db, projectId, baseFolderId);
    if (!parent) return { ok: false, kind: "parent_not_found" };
  }

  const { data, error } = await db.rpc("resolve_project_folder_path", {
    target_project_id: projectId,
    target_user_id: userId,
    base_folder_id: baseFolderId,
    path_segments: segments,
    conflict_resolution: conflictResolution,
  });
  if (error) {
    console.error("[projects/folder-paths/resolve] failed", {
      projectId,
      userId,
      error: error,
    });
    return { ok: false, kind: "rpc_error" };
  }
  return { ok: true, data };
}
