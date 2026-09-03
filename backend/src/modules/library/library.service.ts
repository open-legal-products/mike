// Business logic + data access for the library module.
//
// The library organises a user's standalone (project_id === null) documents
// into two collections — "files" and "templates" — each with an optional
// folder tree (library_folders). These functions take an explicit Supabase
// client (`db`) plus request-derived primitives and RETURN typed results;
// the thin route handlers in library.routes.ts map them onto HTTP responses.

import type { Db } from "../../lib/supabase";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import type { PaginationParams } from "../../lib/pagination";

export type LibraryKind = "file" | "template";

const LIBRARY_IDS_PAGE_SIZE = 1000;
const LIBRARY_IDS_MAX_PAGES = 50;
const LIBRARY_BULK_DELETE_BATCH_SIZE = 100;

export function normalizeLibraryKind(value: unknown): LibraryKind | null {
  if (value === "file" || value === "files") return "file";
  if (value === "template" || value === "templates") return "template";
  return null;
}

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

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
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("library_folders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("user_id", userId)
    .eq("library_kind", kind)
    .maybeSingle();
  return (data as { id: string; parent_folder_id: string | null } | null) ?? null;
}

async function deleteLibraryDocumentsAndVersionFiles(
  db: Db,
  userId: string,
  kind: LibraryKind,
  documentIds: string[],
) {
  if (documentIds.length === 0) return { error: null, deletedIds: [] };
  let eligibleQuery = db
    .from("documents")
    .select("id")
    .eq("user_id", userId)
    .is("project_id", null);
  eligibleQuery =
    kind === "file"
      ? eligibleQuery.or("library_kind.eq.file,library_kind.is.null")
      : eligibleQuery.eq("library_kind", kind);
  const { data: eligibleDocuments, error: eligibleError } =
    await eligibleQuery.in("id", documentIds);
  if (eligibleError) return { error: eligibleError, deletedIds: [] };
  const eligibleIds = (eligibleDocuments ?? []).map(
    (document) => document.id as string,
  );
  if (eligibleIds.length === 0) return { error: null, deletedIds: [] };

  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", eligibleIds);
  if (versionsError) return { error: versionsError, deletedIds: [] };

  const paths = new Set<string>();
  for (const version of versions ?? []) {
    if (typeof version.storage_path === "string" && version.storage_path) {
      paths.add(version.storage_path);
    }
    if (
      typeof version.pdf_storage_path === "string" &&
      version.pdf_storage_path
    ) {
      paths.add(version.pdf_storage_path);
    }
  }
  let deleteQuery = db
    .from("documents")
    .delete()
    .eq("user_id", userId)
    .is("project_id", null);
  deleteQuery =
    kind === "file"
      ? deleteQuery.or("library_kind.eq.file,library_kind.is.null")
      : deleteQuery.eq("library_kind", kind);
  const { error } = await deleteQuery.in("id", eligibleIds);
  // Rows first, files second (durable storage.cleanup job) — previously each
  // file delete was fire-and-forget, so one storage hiccup leaked the bytes.
  if (!error) await enqueueStorageCleanup(db, [...paths]);
  return { error: error ?? null, deletedIds: error ? [] : eligibleIds };
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
) {
  let documentsQuery = db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null);
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

  let foldersQuery = db
    .from("library_folders")
    .select("*")
    .eq("user_id", userId)
    .eq("library_kind", kind);
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
): Promise<
  ServiceResult<{
    documents: unknown[];
    folders: unknown[];
    documentsHasMore: boolean;
  }>
> {
  if (parentFolderId) {
    const folder = await loadLibraryFolder(db, userId, kind, parentFolderId);
    if (!folder) return err(404, "Folder not found");
  }
  const result = await loadLibraryLevel(db, userId, kind, parentFolderId, pagination);
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
          result: await loadLibraryLevel(db, userId, kind, level.parentId, {
            limit: level.limit,
            offset: 0,
          }),
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
): Promise<ServiceResult<{ fileTypes: string[] }>> {
  const { data, error } = await db.rpc("get_library_filter_options", {
    p_user_id: userId,
    p_library_kind: kind,
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
): Promise<ServiceResult<{ folders: unknown[] }>> {
  const { data, error } = await db
    .from("library_folders")
    .select("*")
    .eq("user_id", userId)
    .eq("library_kind", kind);
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
): Promise<ServiceResult<unknown>> {
  const rawSegments = Array.isArray(body.segments) ? body.segments : [];
  const segments = Array.isArray(body.segments)
    ? body.segments
        .filter((segment): segment is string => typeof segment === "string")
        .map((segment) => segment.trim())
    : [];
  // A non-string segment is dropped by the filter above, so a length mismatch
  // means the caller sent something that isn't a path at all.
  if (
    rawSegments.length !== segments.length ||
    segments.length === 0 ||
    segments.length > 100 ||
    segments.some((segment) => !segment || segment.length > 255)
  ) {
    return err(400, "Invalid folder path");
  }
  const conflictResolution =
    body.conflict_resolution === "reuse" || body.conflict_resolution === "rename"
      ? body.conflict_resolution
      : "error";
  const baseFolderId =
    typeof body.base_folder_id === "string" && body.base_folder_id.trim()
      ? body.base_folder_id.trim()
      : null;

  if (baseFolderId) {
    const parent = await loadLibraryFolder(db, userId, kind, baseFolderId);
    if (!parent) return err(404, "Parent folder not found");
  }

  const { data, error } = await db.rpc("resolve_library_folder_path", {
    target_user_id: userId,
    target_library_kind: kind,
    base_folder_id: baseFolderId,
    path_segments: segments,
    conflict_resolution: conflictResolution,
  });
  if (error) return internalErr(error);
  return ok(data);
}

export async function createLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  body: { name?: string; parent_folder_id?: string | null },
): Promise<ServiceResult<unknown>> {
  const { name, parent_folder_id } = body;
  if (!name?.trim()) return err(400, "name is required");

  if (parent_folder_id) {
    const parent = await loadLibraryFolder(db, userId, kind, parent_folder_id);
    if (!parent) return err(404, "Parent folder not found");
  }

  const { data, error } = await db
    .from("library_folders")
    .insert({
      user_id: userId,
      library_kind: kind,
      name: name.trim(),
      parent_folder_id: parent_folder_id ?? null,
    })
    .select("*")
    .single();
  if (error) return internalErr(error);
  return ok(data);
}

export async function updateLibraryFolder(
  db: Db,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  body: { name?: string; parent_folder_id?: string | null },
): Promise<ServiceResult<unknown>> {
  const folder = await loadLibraryFolder(db, userId, kind, folderId);
  if (!folder) return err(404, "Folder not found");

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name != null) {
    const trimmed = body.name.trim();
    if (!trimmed) return err(400, "name is required");
    updates.name = trimmed;
  }
  if ("parent_folder_id" in body) {
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) {
          return err(400, "Cannot move a folder into itself or a descendant");
        }
        const parent = await loadLibraryFolder(db, userId, kind, cur);
        if (!parent) return err(404, "Parent folder not found");
        cur = parent.parent_folder_id ?? null;
      }
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
): Promise<ServiceResult<null>> {
  const { data: allFolders, error: foldersError } = await db
    .from("library_folders")
    .select("id, parent_folder_id")
    .eq("user_id", userId)
    .eq("library_kind", kind);
  if (foldersError) return internalErr(foldersError);
  if (!(allFolders ?? []).some((folder) => folder.id === folderId)) {
    return err(404, "Folder not found");
  }

  const childrenByParent = new Map<string, string[]>();
  for (const folder of allFolders ?? []) {
    const parentId = folder.parent_folder_id as string | null;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder.id as string);
    childrenByParent.set(parentId, children);
  }

  const folderIds = new Set<string>();
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (folderIds.has(id)) continue;
    folderIds.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }

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
): Promise<ServiceResult<unknown>> {
  if (folder_id) {
    const folder = await loadLibraryFolder(db, userId, kind, folder_id);
    if (!folder) return err(404, "Folder not found");
  }

  let moveQuery = db
    .from("documents")
    .update({
      library_folder_id: folder_id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .eq("user_id", userId)
    .is("project_id", null);
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
  let docQuery = db
    .from("documents")
    .select("id, current_version_id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .is("project_id", null);
  docQuery =
    kind === "file"
      ? docQuery.or("library_kind.eq.file,library_kind.is.null")
      : docQuery.eq("library_kind", kind);
  const { data: doc } = await docQuery.single();
  if (!doc) return err(404, "Document not found");

  const active = doc.current_version_id
    ? await db
        .from("document_versions")
        .select("filename")
        .eq("id", doc.current_version_id)
        .eq("document_id", documentId)
        .single()
    : null;
  const currentName =
    typeof active?.data?.filename === "string" && active.data.filename.trim()
      ? active.data.filename.trim()
      : "Untitled document";
  const filename = normalizeDocumentFilename(rawFilename, currentName);
  if (!filename) return err(400, "filename is required");

  let updateQuery = db
    .from("documents")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", userId)
    .is("project_id", null);
  updateQuery =
    kind === "file"
      ? updateQuery.or("library_kind.eq.file,library_kind.is.null")
      : updateQuery.eq("library_kind", kind);
  const { data: updated, error } = await updateQuery
    .select("*")
    .single();
  if (error || !updated) return err(404, "Document not found");

  if (doc.current_version_id) {
    await db
      .from("document_versions")
      .update({ filename })
      .eq("id", doc.current_version_id)
      .eq("document_id", documentId);
  }

  return ok(mapLibraryDocument({ ...updated, filename }));
}
