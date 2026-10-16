// Business logic + data access for the library module.
//
// The library organises a user's standalone (project_id === null) documents
// into two collections — "files" and "templates" — each with an optional
// folder tree (library_folders). It is per workspace: what a person uploads
// in an organization's workspace is filed under that organization, private
// to them, and listed only there. These functions take an explicit Supabase
// client (`db`) plus request-derived primitives and RETURN typed results;
// the thin route handlers in library.routes.ts map them onto HTTP responses.

import { parseFolderPath, validateFolderMove, collectFolderSubtree } from "../../lib/folderTree";
import { renameDocument, deleteCollectionDocuments } from "../documents/documents.service";
import type { Db } from "../../lib/supabase";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import type { PaginationParams } from "../../lib/pagination";
import {
  PERSONAL_WORKSPACE,
  workspaceRpcArg,
  type WorkspaceFilter,
} from "../../lib/workspace";

export type LibraryKind = "file" | "template";

const LIBRARY_IDS_PAGE_SIZE = 1000;
const LIBRARY_IDS_MAX_PAGES = 50;
const LIBRARY_BULK_DELETE_BATCH_SIZE = 100;

export function normalizeLibraryKind(value: unknown): LibraryKind | null {
  if (value === "file" || value === "files") return "file";
  if (value === "template" || value === "templates") return "template";
  return null;
}

// The library is per workspace: a person's own documents and folders in
// Personal, and their own in each organization they belong to. `workspace`
// narrows every list here to one of them — "personal", an organization id,
// or null for a caller that predates workspaces, which is not narrowed.
//
// Whatever the caller asks to see, a folder and what is in it are always in
// the same workspace: a document is never moved into another workspace's
// folder, and a new folder takes its parent's.

// The query builders' own types are too deep to thread through a generic
// constraint, so these ask only for the two filters they use.
type OrgNarrowable = {
  eq(column: string, value: string): unknown;
  is(column: string, value: null): unknown;
};

/** Narrow a documents or library_folders query to one workspace. */
function inWorkspace<Q>(query: Q, workspace: WorkspaceFilter): Q {
  if (!workspace) return query;
  const narrowable = query as unknown as OrgNarrowable;
  return (
    workspace === PERSONAL_WORKSPACE
      ? narrowable.is("org_id", null)
      : narrowable.eq("org_id", workspace)
  ) as Q;
}

/** Narrow a query to exactly the workspace `orgId` names (null: Personal). */
function inOrg<Q>(query: Q, orgId: string | null): Q {
  const narrowable = query as unknown as OrgNarrowable;
  return (
    orgId ? narrowable.eq("org_id", orgId) : narrowable.is("org_id", null)
  ) as Q;
}

/** The org_id a new row gets in `workspace`: null for Personal or unscoped. */
function workspaceOrgId(workspace: WorkspaceFilter): string | null {
  return workspace && workspace !== PERSONAL_WORKSPACE ? workspace : null;
}

type LibraryFolderRef = {
  id: string;
  parent_folder_id: string | null;
  org_id: string | null;
};

function mapLibraryDocument<T extends Record<string, unknown>>(doc: T) {
  return {
    ...doc,
    folder_id: (doc.library_folder_id as string | null | undefined) ?? null,
  };
}

async function loadLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  workspace: WorkspaceFilter = null,
): Promise<LibraryFolderRef | null> {
  const { data } = await inWorkspace(
    db
      .from("library_folders")
      .select("id, parent_folder_id, org_id")
      .eq("id", folderId)
      .eq("user_id", userId)
      .eq("library_kind", kind),
    workspace,
  ).maybeSingle();
  if (!data) return null;
  const row = data as Partial<LibraryFolderRef> & { id: string };
  return {
    id: row.id,
    parent_folder_id: row.parent_folder_id ?? null,
    org_id: row.org_id ?? null,
  };
}

async function deleteLibraryDocumentsAndVersionFiles(
  db: Db,
  userId: string,
  kind: LibraryKind,
  documentIds: string[],
) {
  const result = await deleteCollectionDocuments(
    db, { kind: "library", userId, libraryKind: kind }, documentIds,
  );
  return result.ok
    ? { error: null, deletedIds: result.data.deletedIds }
    : {
        error: result.kind === "error" ? result.error : result.detail,
        deletedIds: [],
      };
}

export type ServiceOk<T> = { ok: true; data: T };
// Two shapes of failure, because the HTTP layer answers them differently:
// "status" carries a caller-facing status + detail (bad input, missing row);
// "internal" carries the raw driver error, which the route hands to
// sendInternalError so the message is logged rather than echoed to the client.
export type ServiceErr =
  | { ok: false; failure: "status"; status: number; detail: string }
  | { ok: false; failure: "internal"; error: unknown };
export type ServiceResult<T> = ServiceOk<T> | ServiceErr;

const ok = <T>(data: T): ServiceOk<T> => ({ ok: true, data });
const err = (status: number, detail: string): ServiceErr => ({
  ok: false,
  failure: "status",
  status,
  detail,
});
const internalErr = (error: unknown): ServiceErr => ({
  ok: false,
  failure: "internal",
  error,
});

// Folders per level are assumed to stay small (organizational containers,
// not user data that grows unbounded) and are always returned in full.
// Documents are the part that can grow into the thousands, so only they're
// paginated — one extra row is fetched over `limit` to detect `hasMore`
// without a separate count query.
async function loadLibraryLevel(
  db: Db,
  userId: string,
  kind: LibraryKind,
  parentFolderId: string | null,
  pagination: PaginationParams,
  workspace: WorkspaceFilter = null,
) {
  let documentsQuery = inWorkspace(
    db
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .is("project_id", null),
    workspace,
  );
  documentsQuery =
    parentFolderId === null
      ? documentsQuery.is("library_folder_id", null)
      : documentsQuery.eq("library_folder_id", parentFolderId);
  documentsQuery =
    kind === "file"
      ? documentsQuery.or("library_kind.eq.file,library_kind.is.null")
      : documentsQuery.eq("library_kind", kind);
  documentsQuery = documentsQuery.range(
    pagination.offset,
    pagination.offset + pagination.limit,
  );

  let foldersQuery = inWorkspace(
    db
      .from("library_folders")
      .select("*")
      .eq("user_id", userId)
      .eq("library_kind", kind),
    workspace,
  );
  foldersQuery =
    parentFolderId === null
      ? foldersQuery.is("parent_folder_id", null)
      : foldersQuery.eq("parent_folder_id", parentFolderId);

  const [{ data: docs, error: docsError }, { data: folders, error: foldersError }] =
    await Promise.all([
      documentsQuery.order("updated_at", { ascending: false }),
      foldersQuery.order("updated_at", { ascending: false }),
    ]);
  if (docsError)
    return {
      error: docsError.message,
      documents: [],
      folders: [],
      documentsHasMore: false,
    };
  if (foldersError)
    return {
      error: foldersError.message,
      documents: [],
      folders: [],
      documentsHasMore: false,
    };

  const rawDocs = docs ?? [];
  const documentsHasMore = rawDocs.length > pagination.limit;
  const pageDocs = documentsHasMore ? rawDocs.slice(0, pagination.limit) : rawDocs;

  const docsTyped = pageDocs.map(mapLibraryDocument) as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  return {
    error: null,
    documents: docsTyped,
    folders: folders ?? [],
    documentsHasMore,
  };
}

export async function getLibrary(
  db: Db,
  userId: string,
  kind: LibraryKind,
  parentFolderId: string | null,
  pagination: PaginationParams,
  workspace: WorkspaceFilter = null,
): Promise<
  ServiceResult<{
    documents: unknown[];
    folders: unknown[];
    documentsHasMore: boolean;
  }>
> {
  if (parentFolderId) {
    const folder = await loadLibraryFolder(
      db,
      userId,
      kind,
      parentFolderId,
      workspace,
    );
    if (!folder) return err(404, "Folder not found");
  }
  const result = await loadLibraryLevel(
    db,
    userId,
    kind,
    parentFolderId,
    pagination,
    workspace,
  );
  if (result.error) return err(500, result.error);
  return ok({
    documents: result.documents,
    folders: result.folders,
    documentsHasMore: result.documentsHasMore,
  });
}

export async function searchLibraryDocuments(
  db: Db,
  userId: string,
  kind: LibraryKind,
  searchTerm: string | null,
  fileType: string | null,
  sort: { key: string; direction: "asc" | "desc" },
  pagination: PaginationParams,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<{ documents: unknown[]; documentsHasMore: boolean }>> {
  const { data, error } = await db.rpc("search_library_documents", {
    p_user_id: userId,
    p_library_kind: kind,
    p_limit: pagination.limit + 1,
    p_offset: pagination.offset,
    p_search_term: searchTerm,
    p_file_type: fileType,
    p_sort_key: sort.key,
    p_sort_direction: sort.direction,
    ...workspaceRpcArg(workspace),
  });
  if (error) return internalErr(error);

  const rows = (data ?? []) as Record<string, unknown>[];
  return ok({
    documents: rows.slice(0, pagination.limit).map(mapLibraryDocument),
    documentsHasMore: rows.length > pagination.limit,
  });
}

export async function getLibraryLevels(
  db: Db,
  userId: string,
  kind: LibraryKind,
  levels: Array<{ parentId: string | null; limit: number }>,
  workspace: WorkspaceFilter = null,
): Promise<
  ServiceResult<{
    levels: Array<{
      parentId: string | null;
      documents: unknown[];
      folders: unknown[];
      documentsHasMore: boolean;
    }>;
  }>
> {
  const results: Array<{
    parentId: string | null;
    result: Awaited<ReturnType<typeof loadLibraryLevel>>;
  }> = new Array(levels.length);
  let nextLevelIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, levels.length) }, async () => {
      while (nextLevelIndex < levels.length) {
        const index = nextLevelIndex++;
        const level = levels[index];
        results[index] = {
          parentId: level.parentId,
          result: await loadLibraryLevel(
            db,
            userId,
            kind,
            level.parentId,
            { limit: level.limit, offset: 0 },
            workspace,
          ),
        };
      }
    }),
  );
  const failed = results.find(({ result }) => result.error);
  if (failed?.result.error) return err(500, failed.result.error);
  return ok({
    levels: results.map(({ parentId, result }) => ({
      parentId,
      documents: result.documents,
      folders: result.folders,
      documentsHasMore: result.documentsHasMore,
    })),
  });
}

export async function getLibraryFilterOptions(
  db: Db,
  userId: string,
  kind: LibraryKind,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<{ fileTypes: string[] }>> {
  const { data, error } = await db.rpc("get_library_filter_options", {
    p_user_id: userId,
    p_library_kind: kind,
    ...workspaceRpcArg(workspace),
  });
  if (error) return internalErr(error);
  const row = (data?.[0] ?? {}) as { file_types?: unknown };
  return ok({
    fileTypes: Array.isArray(row.file_types)
      ? row.file_types.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  });
}

export async function getLibraryDocumentIds(
  db: Db,
  userId: string,
  kind: LibraryKind,
  searchTerm: string | null,
  fileType: string | null,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<string[]>> {
  const ids: string[] = [];
  let offset = 0;
  for (let page = 0; page < LIBRARY_IDS_MAX_PAGES; page++) {
    const { data, error } = await db.rpc("get_library_document_ids", {
      p_user_id: userId,
      p_library_kind: kind,
      p_search_term: searchTerm,
      p_file_type: fileType,
      p_limit: LIBRARY_IDS_PAGE_SIZE,
      p_offset: offset,
      ...workspaceRpcArg(workspace),
    });
    if (error) return internalErr(error);
    const rows = (data ?? []) as { id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows.map((row) => row.id));
    offset += rows.length;
  }
  return ok(ids);
}

export async function bulkDeleteLibraryDocuments(
  db: Db,
  userId: string,
  kind: LibraryKind,
  ids: string[],
): Promise<ServiceResult<{ deletedIds: string[] }>> {
  const deletedIds: string[] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += LIBRARY_BULK_DELETE_BATCH_SIZE
  ) {
    const batch = ids.slice(offset, offset + LIBRARY_BULK_DELETE_BATCH_SIZE);
    const result = await deleteLibraryDocumentsAndVersionFiles(
      db,
      userId,
      kind,
      batch,
    );
    if (result.error) return internalErr(result.error);
    deletedIds.push(...result.deletedIds);
  }
  return ok({ deletedIds });
}

export async function getLibraryFolderPath(
  db: Db,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<{ folders: unknown[] }>> {
  const { data, error } = await inWorkspace(
    db
      .from("library_folders")
      .select("*")
      .eq("user_id", userId)
      .eq("library_kind", kind),
    workspace,
  );
  if (error) return internalErr(error);

  const folders = data ?? [];
  const foldersById = new Map(
    folders.map((folder) => [folder.id as string, folder]),
  );
  const path: typeof folders = [];
  const visited = new Set<string>();
  let current = foldersById.get(folderId);
  if (!current) return err(404, "Folder not found");

  while (current && !visited.has(current.id as string)) {
    visited.add(current.id as string);
    path.unshift(current);
    current = current.parent_folder_id
      ? foldersById.get(current.parent_folder_id as string)
      : undefined;
  }

  return ok({ folders: path });
}

// Folder-tree upsert for uploads that carry a relative path (drag-and-drop of
// a whole directory): the RPC walks/creates each segment in one round trip so
// concurrent uploads of overlapping paths can't race each other into
// duplicate folders. `conflict_resolution` decides what an existing folder at
// a segment means — reuse it, create a renamed sibling, or fail.
export async function resolveLibraryFolderPath(
  db: Db,
  userId: string,
  kind: LibraryKind,
  body: {
    base_folder_id?: string | null;
    segments?: unknown;
    conflict_resolution?: unknown;
  },
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<unknown>> {
  const path = parseFolderPath(body);
  if (!path) return err(400, "Invalid folder path");
  const { segments, conflictResolution, baseFolderId } = path;

  // The path is walked, and any missing folder made, in one workspace: the
  // base folder's, or the one the caller is working in.
  let orgId = workspaceOrgId(workspace);
  if (baseFolderId) {
    const parent = await loadLibraryFolder(
      db,
      userId,
      kind,
      baseFolderId,
      workspace,
    );
    if (!parent) return err(404, "Parent folder not found");
    orgId = parent.org_id;
  }

  const { data, error } = await db.rpc("resolve_library_folder_path", {
    target_user_id: userId,
    target_library_kind: kind,
    base_folder_id: baseFolderId,
    path_segments: segments,
    conflict_resolution: conflictResolution,
    ...(orgId ? { target_org_id: orgId } : {}),
  });
  if (error) return internalErr(error);
  return ok(data);
}

/** Create a named library folder in the authorized parent or current workspace. */
export async function createLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  body: { name?: unknown; parent_folder_id?: string | null },
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<unknown>> {
  const { name, parent_folder_id } = body;
  if (typeof name !== "string" || !name.trim()) return err(400, "name is required");

  // A folder is in its parent's workspace; at the top level, the one the
  // caller is working in.
  let orgId = workspaceOrgId(workspace);
  if (parent_folder_id) {
    const parent = await loadLibraryFolder(
      db,
      userId,
      kind,
      parent_folder_id,
      workspace,
    );
    if (!parent) return err(404, "Parent folder not found");
    orgId = parent.org_id;
  }

  const { data, error } = await db
    .from("library_folders")
    .insert({
      user_id: userId,
      library_kind: kind,
      name: name.trim(),
      parent_folder_id: parent_folder_id ?? null,
      ...(orgId ? { org_id: orgId } : {}),
    })
    .select("*")
    .single();
  if (error) return internalErr(error);
  return ok(data);
}

/** Rename or move a library folder after checking its workspace and parent tree. */
export async function updateLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  body: { name?: unknown; parent_folder_id?: string | null },
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<unknown>> {
  const folder = await loadLibraryFolder(db, userId, kind, folderId, workspace);
  if (!folder) return err(404, "Folder not found");

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if ("name" in body) {
    if (typeof body.name !== "string") return err(400, "name must be a non-empty string");
    const trimmed = body.name.trim();
    if (!trimmed) return err(400, "name is required");
    updates.name = trimmed;
  }
  if ("parent_folder_id" in body) {
    if (body.parent_folder_id) {
      const moveError = await validateFolderMove(
        folderId, body.parent_folder_id,
        (id) => loadLibraryFolder(db, userId, kind, id),
      );
      if (moveError === "cycle")
        return err(400, "Cannot move a folder into itself or a descendant");
      if (moveError) return err(404, "Parent folder not found");
      // A folder stays in its workspace: a parent in another one is, to
      // this folder, not there.
      const parent = await loadLibraryFolder(
        db,
        userId,
        kind,
        body.parent_folder_id,
      );
      if (!parent || parent.org_id !== folder.org_id)
        return err(404, "Parent folder not found");
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db
    .from("library_folders")
    .update(updates)
    .eq("id", folderId)
    .eq("user_id", userId)
    .eq("library_kind", kind)
    .select("*")
    .single();
  if (error || !data) return err(404, "Folder not found");
  return ok(data);
}

export async function deleteLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<null>> {
  const { data: allFolders, error: foldersError } = await inWorkspace(
    db
      .from("library_folders")
      .select("id, parent_folder_id")
      .eq("user_id", userId)
      .eq("library_kind", kind),
    workspace,
  );
  if (foldersError) return internalErr(foldersError);
  if (!(allFolders ?? []).some((folder) => folder.id === folderId)) {
    return err(404, "Folder not found");
  }

  const folderIds = collectFolderSubtree(folderId, allFolders ?? []);

  let documentsInFolderQuery = db
    .from("documents")
    .select("id")
    .eq("user_id", userId)
    .is("project_id", null);
  documentsInFolderQuery =
    kind === "file"
      ? documentsInFolderQuery.or("library_kind.eq.file,library_kind.is.null")
      : documentsInFolderQuery.eq("library_kind", kind);
  const { data: docs, error: docsError } = await documentsInFolderQuery.in(
    "library_folder_id",
    [...folderIds],
  );
  if (docsError) return internalErr(docsError);

  const docIds = (docs ?? []).map((doc) => doc.id as string);
  const deleteDocsResult = await deleteLibraryDocumentsAndVersionFiles(
    db,
    userId,
    kind,
    docIds,
  );
  if (deleteDocsResult.error) return internalErr(deleteDocsResult.error);

  const { error } = await db
    .from("library_folders")
    .delete()
    .eq("id", folderId)
    .eq("user_id", userId)
    .eq("library_kind", kind);
  if (error) return internalErr(error);
  return ok(null);
}

export async function moveLibraryDocument(
  db: Db,
  userId: string,
  kind: LibraryKind,
  documentId: string,
  folder_id: string | null,
  workspace: WorkspaceFilter = null,
): Promise<ServiceResult<unknown>> {
  let folder: LibraryFolderRef | null = null;
  if (folder_id) {
    folder = await loadLibraryFolder(db, userId, kind, folder_id, workspace);
    if (!folder) return err(404, "Folder not found");
  }

  let moveQuery = inWorkspace(
    db
      .from("documents")
      .update({
        library_folder_id: folder_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .eq("user_id", userId)
      .is("project_id", null),
    workspace,
  );
  // Into a folder: only a document of that folder's workspace. One from
  // another workspace matches nothing, and is reported as not found.
  if (folder) moveQuery = inOrg(moveQuery, folder.org_id);
  moveQuery =
    kind === "file"
      ? moveQuery.or("library_kind.eq.file,library_kind.is.null")
      : moveQuery.eq("library_kind", kind);
  const { data, error } = await moveQuery
    .select("*")
    .single();
  if (error || !data) return err(404, "Document not found");
  return ok(mapLibraryDocument(data));
}

export async function renameLibraryDocument(
  db: Db,
  userId: string,
  kind: LibraryKind,
  documentId: string,
  rawFilename: unknown,
): Promise<ServiceResult<unknown>> {
  const result = await renameDocument(db, {
    userId,
    documentId,
    filename: rawFilename,
    scope: { kind: "library", libraryKind: kind },
  });
  if (result.ok) return ok(mapLibraryDocument(result.data));
  if (result.kind === "error") return internalErr(result.error);
  return err(result.kind === "validation" ? 400 : 404, result.detail);
}
