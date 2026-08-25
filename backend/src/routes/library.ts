import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { deleteFile } from "../lib/storage";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { parsePaginationQuery, type PaginationParams } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { sendInternalError } from "../lib/httpError";

export const libraryRouter = Router();

type LibraryKind = "file" | "template";
type LibraryDocumentSortKey =
  | "name"
  | "type"
  | "size"
  | "version"
  | "created"
  | "updated";

const LIBRARY_DOCUMENT_SORT_KEYS: LibraryDocumentSortKey[] = [
  "name",
  "type",
  "size",
  "version",
  "created",
  "updated",
];
const LIBRARY_IDS_PAGE_SIZE = 1000;
const LIBRARY_IDS_MAX_PAGES = 50;
const LIBRARY_BULK_DELETE_BATCH_SIZE = 100;

function parseLibraryDocumentSort(query: Record<string, unknown>): {
  key: LibraryDocumentSortKey;
  direction: "asc" | "desc";
} {
  const rawKey = typeof query.sort_key === "string" ? query.sort_key : null;
  return {
    key:
      rawKey && LIBRARY_DOCUMENT_SORT_KEYS.includes(rawKey as LibraryDocumentSortKey)
        ? (rawKey as LibraryDocumentSortKey)
        : "updated",
    direction: query.sort_direction === "asc" ? "asc" : "desc",
  };
}

function normalizeLibraryKind(value: unknown): LibraryKind | null {
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
  db: ReturnType<typeof createServerSupabase>,
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
  return (
    (data as { id: string; parent_folder_id: string | null } | null) ?? null
  );
}

async function deleteLibraryDocumentsAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
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
  await Promise.all([...paths].map((path) => deleteFile(path).catch(() => {})));

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
  return { error: error ?? null, deletedIds: error ? [] : eligibleIds };
}

// Folders per level are assumed to stay small (organizational containers,
// not user data that grows unbounded) and are always returned in full.
// Documents are the part that can grow into the thousands, so only they're
// paginated — one extra row is fetched over `limit` to detect `hasMore`
// without a separate count query.
async function loadLibraryLevel(
  db: ReturnType<typeof createServerSupabase>,
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

  const [
    { data: docs, error: docsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
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
  const pageDocs = documentsHasMore
    ? rawDocs.slice(0, pagination.limit)
    : rawDocs;

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

// GET /library/:kind
// Directory mode is the default. Pass parent_folder_id to load one folder
// level, or view=search for flat search/filter/sort results.
libraryRouter.get("/:kind", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
  if (req.query.view === "search") {
    const searchTerm = normalizeSearchTerm(req.query.search);
    const fileType =
      normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
    const sort = parseLibraryDocumentSort(
      req.query as Record<string, unknown>,
    );
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
    if (error) return void sendInternalError(res, error);

    const rows = (data ?? []) as Record<string, unknown>[];
    return void res.json({
      documents: rows.slice(0, pagination.limit).map(mapLibraryDocument),
      documentsHasMore: rows.length > pagination.limit,
    });
  }

  const parentFolderId = normalizeSearchTerm(req.query.parent_folder_id);
  if (parentFolderId) {
    const folder = await loadLibraryFolder(db, userId, kind, parentFolderId);
    if (!folder)
      return void res.status(404).json({ detail: "Folder not found" });
  }
  const result = await loadLibraryLevel(
    db,
    userId,
    kind,
    parentFolderId,
    pagination,
  );
  if (result.error) return void res.status(500).json({ detail: result.error });
  res.json({
    documents: result.documents,
    folders: result.folders,
    documentsHasMore: result.documentsHasMore,
  });
});

// POST /library/:kind/levels
// Refresh several already-open directory levels through one bounded API call.
libraryRouter.post("/:kind/levels", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });
  const rawLevels: unknown[] = Array.isArray(req.body?.levels)
    ? req.body.levels
    : [];
  const seen = new Set<string>();
  const levels = rawLevels.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const row = value as { parentId?: unknown; limit?: unknown };
    const parentId = typeof row.parentId === "string" ? row.parentId : null;
    const key = parentId ?? "root";
    if (seen.has(key)) return [];
    seen.add(key);
    const requestedLimit = Number(row.limit);
    return [
      {
        parentId,
        limit: Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
          : 40,
      },
    ];
  });
  if (levels.length === 0 || levels.length > 100) {
    return void res
      .status(400)
      .json({ detail: "1 to 100 levels are required" });
  }

  const db = createServerSupabase();
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
  if (failed?.result.error) {
    return void res.status(500).json({ detail: failed.result.error });
  }
  res.json({
    levels: results.map(({ parentId, result }) => ({
      parentId,
      documents: result.documents,
      folders: result.folders,
      documentsHasMore: result.documentsHasMore,
    })),
  });
});

// GET /library/:kind/filter-options
libraryRouter.get("/:kind/filter-options", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const { data, error } = await db.rpc("get_library_filter_options", {
    p_user_id: userId,
    p_library_kind: kind,
  });
  if (error) return void sendInternalError(res, error);
  const row = (data?.[0] ?? {}) as { file_types?: unknown };
  res.json({
    fileTypes: Array.isArray(row.file_types)
      ? row.file_types.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  });
});

// GET /library/:kind/ids
// Complete ID-only result set for select-all across unloaded pages/folders.
libraryRouter.get("/:kind/ids", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const searchTerm = normalizeSearchTerm(req.query.search);
  const fileType = normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
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
    if (error) return void sendInternalError(res, error);
    const rows = (data ?? []) as { id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows.map((row) => row.id));
    offset += rows.length;
  }
  res.json(ids);
});

// POST /library/:kind/documents/bulk-delete
// One bounded backend operation replaces an unbounded browser request burst.
libraryRouter.post(
  "/:kind/documents/bulk-delete",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const ids: string[] = Array.from(
      new Set<string>(
        (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(
          (id: unknown): id is string =>
            typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) return void res.json({ deletedIds: [] });

    const db = createServerSupabase();
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
      if (result.error)
        return void sendInternalError(res, result.error);
      deletedIds.push(...result.deletedIds);
    }
    res.json({ deletedIds });
  },
);

// GET /library/:kind/folders/:folderId
libraryRouter.get(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const db = createServerSupabase();
    const { data, error } = await db
      .from("library_folders")
      .select("*")
      .eq("user_id", userId)
      .eq("library_kind", kind);
    if (error) return void sendInternalError(res, error);

    const folders = data ?? [];
    const foldersById = new Map(
      folders.map((folder) => [folder.id as string, folder]),
    );
    const path: typeof folders = [];
    const visited = new Set<string>();
    let current = foldersById.get(req.params.folderId);
    if (!current)
      return void res.status(404).json({ detail: "Folder not found" });

    while (current && !visited.has(current.id as string)) {
      visited.add(current.id as string);
      path.unshift(current);
      current = current.parent_folder_id
        ? foldersById.get(current.parent_folder_id as string)
        : undefined;
    }

    res.json({ folders: path });
  },
);

// POST /library/:kind/folder-paths/resolve
libraryRouter.post(
  "/:kind/folder-paths/resolve",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const body = req.body as {
      base_folder_id?: string | null;
      segments?: unknown;
      conflict_resolution?: unknown;
    };
    const rawSegments = Array.isArray(body.segments) ? body.segments : [];
    const segments = Array.isArray(body.segments)
      ? body.segments
          .filter((segment): segment is string => typeof segment === "string")
          .map((segment) => segment.trim())
      : [];
    if (
      rawSegments.length !== segments.length ||
      segments.length === 0 ||
      segments.length > 100 ||
      segments.some((segment) => !segment || segment.length > 255)
    ) {
      return void res.status(400).json({ detail: "Invalid folder path" });
    }
    const conflictResolution =
      body.conflict_resolution === "reuse" ||
      body.conflict_resolution === "rename"
        ? body.conflict_resolution
        : "error";
    const baseFolderId =
      typeof body.base_folder_id === "string" && body.base_folder_id.trim()
        ? body.base_folder_id.trim()
        : null;

    const db = createServerSupabase();
    if (baseFolderId) {
      const parent = await loadLibraryFolder(db, userId, kind, baseFolderId);
      if (!parent)
        return void res.status(404).json({ detail: "Parent folder not found" });
    }

    const { data, error } = await db.rpc("resolve_library_folder_path", {
      target_user_id: userId,
      target_library_kind: kind,
      base_folder_id: baseFolderId,
      path_segments: segments,
      conflict_resolution: conflictResolution,
    });
    if (error) return void sendInternalError(res, error);
    res.json(data);
  },
);

// POST /library/:kind/folders
libraryRouter.post("/:kind/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const { name, parent_folder_id } = req.body as {
    name?: string;
    parent_folder_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  if (parent_folder_id) {
    const parent = await loadLibraryFolder(db, userId, kind, parent_folder_id);
    if (!parent)
      return void res.status(404).json({ detail: "Parent folder not found" });
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
  if (error) return void sendInternalError(res, error);
  res.status(201).json(data);
});

// PATCH /library/:kind/folders/:folderId
libraryRouter.patch(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
    const body = req.body as {
      name?: string;
      parent_folder_id?: string | null;
    };
  const db = createServerSupabase();
  const folder = await loadLibraryFolder(db, userId, kind, folderId);
    if (!folder)
      return void res.status(404).json({ detail: "Folder not found" });

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name != null) {
    const trimmed = body.name.trim();
    if (!trimmed)
      return void res.status(400).json({ detail: "name is required" });
    updates.name = trimmed;
  }
  if ("parent_folder_id" in body) {
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) {
          return void res.status(400).json({
            detail: "Cannot move a folder into itself or a descendant",
          });
        }
        const parent = await loadLibraryFolder(db, userId, kind, cur);
        if (!parent)
            return void res
              .status(404)
              .json({ detail: "Parent folder not found" });
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
  if (error || !data)
    return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
  },
);

// DELETE /library/:kind/folders/:folderId
libraryRouter.delete(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
  const db = createServerSupabase();
  const { data: allFolders, error: foldersError } = await db
    .from("library_folders")
    .select("id, parent_folder_id")
    .eq("user_id", userId)
    .eq("library_kind", kind);
  if (foldersError)
    return void sendInternalError(res, foldersError);
  if (!(allFolders ?? []).some((folder) => folder.id === folderId)) {
    return void res.status(404).json({ detail: "Folder not found" });
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
    if (docsError)
      return void sendInternalError(res, docsError);

  const docIds = (docs ?? []).map((doc) => doc.id as string);
    const deleteDocsResult = await deleteLibraryDocumentsAndVersionFiles(
    db,
    userId,
    kind,
    docIds,
  );
    if (deleteDocsResult.error)
      return void sendInternalError(res, deleteDocsResult.error);

  const { error } = await db
    .from("library_folders")
    .delete()
    .eq("id", folderId)
    .eq("user_id", userId)
    .eq("library_kind", kind);
  if (error) return void sendInternalError(res, error);
  res.status(204).send();
  },
);

// PATCH /library/:kind/documents/:documentId/folder
libraryRouter.patch(
  "/:kind/documents/:documentId/folder",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const { folder_id } = req.body as { folder_id: string | null };
    const db = createServerSupabase();

    if (folder_id) {
      const folder = await loadLibraryFolder(db, userId, kind, folder_id);
      if (!folder)
        return void res.status(404).json({ detail: "Folder not found" });
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
    const { data, error } = await moveQuery.select("*").single();
    if (error || !data)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(mapLibraryDocument(data));
  },
);

// PATCH /library/:kind/documents/:documentId
libraryRouter.patch(
  "/:kind/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const db = createServerSupabase();
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
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

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
    const filename = normalizeDocumentFilename(req.body?.filename, currentName);
    if (!filename)
      return void res.status(400).json({ detail: "filename is required" });

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
    const { data: updated, error } = await updateQuery.select("*").single();
    if (error || !updated)
      return void res.status(404).json({ detail: "Document not found" });

    if (doc.current_version_id) {
      await db
        .from("document_versions")
        .update({ filename })
        .eq("id", doc.current_version_id)
        .eq("document_id", documentId);
    }

    res.json(mapLibraryDocument({ ...updated, filename }));
  },
);
