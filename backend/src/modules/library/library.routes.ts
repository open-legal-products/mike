// HTTP surface for the library module.
//
//   GET    /library/:kind                              — documents + folders (directory level or view=search)
//   POST   /library/:kind/levels                       — refresh several directory levels at once
//   GET    /library/:kind/filter-options               — distinct file types for filters
//   GET    /library/:kind/ids                          — full ID set for select-all
//   POST   /library/:kind/documents/bulk-delete        — delete many documents
//   GET    /library/:kind/folders/:folderId            — folder ancestry path
//   POST   /library/:kind/folder-paths/resolve         — walk/create a folder path
//   POST   /library/:kind/folders                      — create a folder
//   PATCH  /library/:kind/folders/:folderId            — rename / move a folder
//   DELETE /library/:kind/folders/:folderId            — delete a folder (+ docs)
//   PATCH  /library/:kind/documents/:documentId/folder — move a document
//   PATCH  /library/:kind/documents/:documentId        — rename a document
//
// `:kind` is "files" | "templates" and maps to library_kind "file" | "template".

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import {
  resolveWorkspaceFilter,
  sendWorkspaceFailure,
  type WorkspaceFilter,
} from "../../lib/workspace";
import {
  normalizeLibraryKind,
  getLibrary,
  searchLibraryDocuments,
  getLibraryLevels,
  getLibraryFilterOptions,
  getLibraryDocumentIds,
  bulkDeleteLibraryDocuments,
  getLibraryFolderPath,
  resolveLibraryFolderPath,
  createLibraryFolder,
  updateLibraryFolder,
  deleteLibraryFolder,
  moveLibraryDocument,
  renameLibraryDocument,
  type ServiceErr,
} from "./library.service";

export const libraryRouter = Router();

// The library is per workspace. Every route takes `?workspace=` — "personal"
// or an organization the caller belongs to — and shows, or files into, that
// one. Without it nothing is narrowed and new folders are Personal, which is
// what a client from before workspaces expects.
function resolveLibraryWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Nothing named, nothing to check: no database client is made for it.
  if (req.query.workspace === undefined) {
    res.locals.workspace = null;
    return next();
  }
  resolveWorkspaceFilter(
    createServerSupabase(),
    res.locals.userId as string,
    req.query.workspace,
  ).then((workspace) => {
    if (!workspace.ok) return sendWorkspaceFailure(res, workspace);
    res.locals.workspace = workspace.workspace;
    next();
  }, next);
}
const requireLibraryAuth = [requireAuth, resolveLibraryWorkspace];
const workspaceOf = (res: Response) =>
  (res.locals.workspace ?? null) as WorkspaceFilter;

// The single place service failures become responses: caller-facing ones keep
// their status + detail, driver failures go through sendInternalError so the
// raw message is logged with the request id instead of returned to the client.
function sendServiceError(res: Response, result: ServiceErr) {
  if (result.failure === "internal") {
    sendInternalError(res, result.error);
    return;
  }
  res.status(result.status).json({ detail: result.detail });
}

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

// GET /library/:kind
// Directory mode is the default. Pass parent_folder_id to load one folder
// level, or view=search for flat search/filter/sort results.
libraryRouter.get("/:kind", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
  if (req.query.view === "search") {
    const searchTerm = normalizeSearchTerm(req.query.search);
    const fileType =
      normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
    const sort = parseLibraryDocumentSort(req.query as Record<string, unknown>);
    const result = await searchLibraryDocuments(
      db,
      userId,
      kind,
      searchTerm,
      fileType,
      sort,
      pagination,
      workspaceOf(res),
    );
    if (!result.ok)
      return void sendServiceError(res, result);
    return void res.json(result.data);
  }

  const parentFolderId = normalizeSearchTerm(req.query.parent_folder_id);
  const result = await getLibrary(
    db,
    userId,
    kind,
    parentFolderId,
    pagination,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// POST /library/:kind/levels
// Refresh several already-open directory levels through one bounded API call.
libraryRouter.post("/:kind/levels", requireLibraryAuth, asyncRoute(async (req, res) => {
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
    return void res.status(400).json({ detail: "1 to 100 levels are required" });
  }

  const db = createServerSupabase();
  const result = await getLibraryLevels(
    db,
    userId,
    kind,
    levels,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// GET /library/:kind/filter-options
libraryRouter.get("/:kind/filter-options", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const result = await getLibraryFilterOptions(
    db,
    userId,
    kind,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// GET /library/:kind/ids
// Complete ID-only result set for select-all across unloaded pages/folders.
libraryRouter.get("/:kind/ids", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const searchTerm = normalizeSearchTerm(req.query.search);
  const fileType =
    normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
  const result = await getLibraryDocumentIds(
    db,
    userId,
    kind,
    searchTerm,
    fileType,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// POST /library/:kind/documents/bulk-delete
// One bounded backend operation replaces an unbounded browser request burst.
libraryRouter.post(
  "/:kind/documents/bulk-delete",
  requireLibraryAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    const ids: string[] = Array.from(
      new Set<string>(
        (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(
          (id: unknown): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) return void res.json({ deletedIds: [] });

    const db = createServerSupabase();
    const result = await bulkDeleteLibraryDocuments(db, userId, kind, ids);
    if (!result.ok)
      return void sendServiceError(res, result);
    res.json(result.data);
  }),
);

// GET /library/:kind/folders/:folderId
libraryRouter.get("/:kind/folders/:folderId", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const result = await getLibraryFolderPath(
    db,
    userId,
    kind,
    req.params.folderId,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// POST /library/:kind/folder-paths/resolve
// Walks (and creates) a whole relative folder path in one call, so uploading a
// directory doesn't need a create-folder round trip per level.
libraryRouter.post(
  "/:kind/folder-paths/resolve",
  requireLibraryAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });

    const body = req.body as {
      base_folder_id?: string | null;
      segments?: unknown;
      conflict_resolution?: unknown;
    };
    const db = createServerSupabase();
    const result = await resolveLibraryFolderPath(
      db,
      userId,
      kind,
      body,
      workspaceOf(res),
    );
    if (!result.ok) return void sendServiceError(res, result);
    res.json(result.data);
  }),
);

// POST /library/:kind/folders
libraryRouter.post("/:kind/folders", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const body = req.body as { name?: string; parent_folder_id?: string | null };
  const db = createServerSupabase();
  const result = await createLibraryFolder(
    db,
    userId,
    kind,
    body,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.status(201).json(result.data);
}));

// PATCH /library/:kind/folders/:folderId
libraryRouter.patch("/:kind/folders/:folderId", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };
  const db = createServerSupabase();
  const result = await updateLibraryFolder(
    db,
    userId,
    kind,
    folderId,
    body,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.json(result.data);
}));

// DELETE /library/:kind/folders/:folderId
libraryRouter.delete("/:kind/folders/:folderId", requireLibraryAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
  const db = createServerSupabase();
  const result = await deleteLibraryFolder(
    db,
    userId,
    kind,
    folderId,
    workspaceOf(res),
  );
  if (!result.ok)
    return void sendServiceError(res, result);
  res.status(204).send();
}));

// PATCH /library/:kind/documents/:documentId/folder
libraryRouter.patch(
  "/:kind/documents/:documentId/folder",
  requireLibraryAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const { folder_id } = req.body as { folder_id: string | null };
    const db = createServerSupabase();
    const result = await moveLibraryDocument(
      db,
      userId,
      kind,
      documentId,
      folder_id,
      workspaceOf(res),
    );
    if (!result.ok)
      return void sendServiceError(res, result);
    res.json(result.data);
  }),
);

// PATCH /library/:kind/documents/:documentId
libraryRouter.patch(
  "/:kind/documents/:documentId",
  requireLibraryAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const db = createServerSupabase();
    const result = await renameLibraryDocument(
      db,
      userId,
      kind,
      documentId,
      req.body?.filename,
    );
    if (!result.ok)
      return void sendServiceError(res, result);
    res.json(result.data);
  }),
);

libraryRouter.use(routerErrorHandler("[library]"));
