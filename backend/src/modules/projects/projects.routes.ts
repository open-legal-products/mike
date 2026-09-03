// HTTP layer for the projects module. Handlers parse params/query/body, call
// the service functions in projects.service.ts, and map their typed results
// onto status codes and JSON bodies. Endpoint registration order is
// deliberate — routes shadow each other, so keep new routes below the
// specific paths they must not capture.

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import { parseProjectSort } from "../../lib/sort";
import { parseProjectScope } from "./projects.overview";
import {
  getProjectsOverview,
  getProjectSummaries,
  searchProjectDirectory,
  getProjectFilterOptions,
  listProjectIds,
  createProject,
  getProjectDetail,
  getProjectPeople,
  updateProject,
  deleteProject,
  exportProjectManifest,
  listProjectDocuments,
  getProjectDirectoryLevel,
  assignOrCopyDocument,
  renameProjectDocument,
  listProjectChats,
  createProjectFolder,
  updateProjectFolder,
  deleteProjectFolder,
  moveProjectDocument,
  resolveProjectFolderPath,
  normalizeOptionalString,
} from "./projects.service";

export const projectsRouter = Router();

// GET /projects
// Pass ?include=documents to also receive each project's documents in the
// same response. The directory pickers (useDirectoryData) previously fanned
// out one GET /projects/:id per project to obtain those documents; with N
// projects that burst — auth check plus several DB queries per request —
// could overwhelm the Supabase gateway. Batching keeps it at one request
// and a fixed number of queries regardless of project count.
//
// Pagination is opt-in via query params (limit/offset/search/sort_key or
// key/scope). ProjectsOverview.tsx sends them. Legacy tabular-review project
// pickers call this with no query params and must keep getting the full,
// unpaginated list, so the branch below must never default
// to paginating a request that didn't ask for it.
const PROJECT_PAGINATION_QUERY_KEYS = [
  "limit",
  "offset",
  "search",
  "sort_key",
  "key",
  "sort_direction",
  "direction",
  "scope",
  "practice",
  "owner_user_id",
];

projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const includeDocuments = req.query.include === "documents";
  const db = createServerSupabase();

  // GET /projects?view=directory-search — flat filename/project matches for
  // the document picker. Search results do not pretend that a partially
  // loaded project tree is a complete result set.
  if (req.query.view === "directory-search") {
    const searchTerm = normalizeSearchTerm(req.query.search);
    if (!searchTerm) return void res.json([]);
    const result = await searchProjectDirectory(db, {
      userId,
      userEmail,
      searchTerm,
      pagination: parsePaginationQuery(req.query as Record<string, unknown>),
    });
    if (!result.ok) return void sendInternalError(res, result.error);
    return void res.json(result.data);
  }

  if (req.query.view === "summary") {
    const result = await getProjectSummaries(db, {
      userId,
      userEmail,
      pagination: parsePaginationQuery(req.query as Record<string, unknown>),
    });
    if (!result.ok) return void sendInternalError(res, result.error);
    return void res.json(result.data);
  }

  const hasPaginationParams = PROJECT_PAGINATION_QUERY_KEYS.some(
    (key) => req.query[key] !== undefined,
  );

  const result = await getProjectsOverview(db, {
    userId,
    userEmail,
    includeDocuments,
    filters: hasPaginationParams
      ? {
          scope: parseProjectScope(req.query.scope),
          pagination: parsePaginationQuery(
            req.query as Record<string, unknown>,
          ),
          searchTerm: normalizeSearchTerm(req.query.search),
          sort: parseProjectSort(req.query as Record<string, unknown>),
          practice: normalizeSearchTerm(req.query.practice),
          ownerUserId: normalizeSearchTerm(req.query.owner_user_id),
        }
      : undefined,
  });
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.data);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { name, cm_number, practice, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    practice?: string;
    shared_with?: string[];
  };
  const db = createServerSupabase();

  const result = await createProject(db, {
    userId,
    userEmail,
    name,
    cm_number,
    practice,
    shared_with,
  });
  if (!result.ok) {
    if (result.kind === "db_error")
      return void sendInternalError(res, result.error);
    return void res.status(400).json({ detail: result.detail });
  }
  res.status(201).json(result.project);
});

// GET /projects/:projectId/directory
// Returns one folder level so file pickers can expand projects without
// downloading every document and subfolder for every project up front.
projectsRouter.get("/:projectId/directory", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await getProjectDirectoryLevel(db, {
    projectId,
    userId,
    userEmail,
    parentFolderId: normalizeOptionalString(req.query.parent_folder_id),
    pagination: parsePaginationQuery(req.query as Record<string, unknown>),
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    return void sendInternalError(res, result.error);
  }
  res.json(result.body);
});

// GET /projects/filter-options (must come before /:projectId routes)
projectsRouter.get("/filter-options", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();

  const result = await getProjectFilterOptions(db, { userId, userEmail });
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.body);
});

// GET /projects/ids (must come before /:projectId routes)
// Lightweight id + owner list for every project matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full project payloads just to collect checkboxes.
projectsRouter.get("/ids", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();

  const result = await listProjectIds(db, {
    userId,
    userEmail,
    scope: parseProjectScope(req.query.scope),
    searchTerm: normalizeSearchTerm(req.query.search),
    practice: normalizeSearchTerm(req.query.practice),
    ownerUserId: normalizeSearchTerm(req.query.owner_user_id),
  });
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.ids);
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await getProjectDetail(db, { projectId, userId, userEmail });
  if (!result.ok)
    return void res.status(404).json({ detail: "Project not found" });
  res.json(result.body);
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await getProjectPeople(db, { projectId, userId, userEmail });
  if (!result.ok)
    return void res.status(404).json({ detail: "Project not found" });
  res.json(result.body);
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await updateProject(db, {
    projectId,
    userId,
    userEmail,
    body: req.body ?? {},
  });
  if (!result.ok) {
    if (result.kind === "self_share" || result.kind === "missing_user")
      return void res.status(400).json({ detail: result.detail });
    return void res.status(404).json({ detail: "Project not found" });
  }
  res.json(result.body);
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await deleteProject(db, userId, projectId);
  if (!result.ok) {
    if (result.kind === "not_found")
      return void res.status(404).json({ detail: "Project not found" });
    return void sendInternalError(res, result.error);
  }
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await listProjectDocuments(db, {
    projectId,
    userId,
    userEmail,
  });
  if (!result.ok)
    return void res.status(404).json({ detail: "Project not found" });
  res.json(result.docs);
});

// GET /projects/:projectId/export — tamper-evident manifest of the project's
// documents: every version with its content_sha256 plus the accept/reject
// trail, under a SHA-256 digest that is Ed25519-signed when the deployment has
// MANIFEST_SIGNING_KEY set. To check an export, recompute a downloaded file's
// SHA-256 and compare, then check the manifest's signature against the key
// served at GET /manifest-signing-key. See the README.
projectsRouter.get(
  "/:projectId/export",
  requireAuth,
  requireMfaIfEnrolled,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const result = await exportProjectManifest(db, {
      projectId,
      userId,
      userEmail,
    });
    if (!result.ok) {
      if (result.kind === "forbidden")
        return void res.status(404).json({ detail: "Project not found" });
      return void res
        .status(500)
        .json({ detail: "Failed to build project export manifest" });
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename}"`,
    );
    res.json(result.data);
  },
);

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const result = await assignOrCopyDocument(db, {
      projectId,
      documentId,
      userId,
      userEmail,
    });
    if (!result.ok) {
      switch (result.kind) {
        case "forbidden":
          return void res.status(404).json({ detail: "Project not found" });
        case "doc_not_found":
          return void res.status(404).json({ detail: "Document not found" });
        case "no_active_version":
          return void res
            .status(404)
            .json({ detail: "Source document has no active version" });
        case "update_failed":
          return void res
            .status(500)
            .json({ detail: "Failed to update document" });
        case "read_failed":
          return void res
            .status(500)
            .json({ detail: "Failed to read source document bytes" });
        case "copy_failed":
          return void res
            .status(500)
            .json({ detail: "Failed to copy document" });
      }
    }
    res.status(result.status).json(result.doc);
  },
);

// PATCH /projects/:projectId/documents/:documentId — rename a project document
projectsRouter.patch("/:projectId/documents/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const db = createServerSupabase();

  const result = await renameProjectDocument(db, {
    projectId,
    documentId,
    userId,
    userEmail,
    filename: req.body?.filename,
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    if (result.kind === "doc_not_found")
      return void res.status(404).json({ detail: "Document not found" });
    return void res.status(400).json({ detail: result.detail });
  }
  res.json(result.doc);
});

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const result = await listProjectChats(db, { projectId, userId, userEmail });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    return void sendInternalError(res, result.error);
  }
  res.json(result.chats);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folder-paths/resolve
projectsRouter.post(
  "/:projectId/folder-paths/resolve",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const body = req.body as {
      base_folder_id?: string | null;
      segments?: unknown;
      conflict_resolution?: unknown;
    };

    const db = createServerSupabase();
    const result = await resolveProjectFolderPath(db, {
      projectId,
      userId,
      userEmail,
      body,
    });
    if (!result.ok) {
      if (result.kind === "invalid_path")
        return void res.status(400).json({ detail: "Invalid folder path" });
      if (result.kind === "forbidden")
        return void res.status(404).json({ detail: "Project not found" });
      if (result.kind === "parent_not_found")
        return void res.status(404).json({ detail: "Parent folder not found" });
      return void res.status(500).json({
        detail: "Could not prepare this folder upload. Please try again.",
      });
    }
    res.json(result.data);
  },
);

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const result = await createProjectFolder(db, {
    projectId,
    userId,
    userEmail,
    name,
    parent_folder_id,
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    if (result.kind === "parent_not_found")
      return void res.status(404).json({ detail: "Parent folder not found" });
    return void sendInternalError(res, result.error);
  }
  res.status(201).json(result.folder);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };
  const db = createServerSupabase();

  const result = await updateProjectFolder(db, {
    projectId,
    folderId,
    userId,
    userEmail,
    body,
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    if (result.kind === "parent_not_found")
      return void res.status(404).json({ detail: "Parent folder not found" });
    if (result.kind === "cycle")
      return void res
        .status(400)
        .json({ detail: "Cannot move a folder into itself or a descendant" });
    return void res.status(404).json({ detail: "Folder not found" });
  }
  res.json(result.folder);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  const result = await deleteProjectFolder(db, {
    projectId,
    folderId,
    userId,
    userEmail,
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    if (result.kind === "not_found")
      return void res.status(404).json({ detail: "Folder not found" });
    return void sendInternalError(res, result.error);
  }
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };
  const db = createServerSupabase();

  const result = await moveProjectDocument(db, {
    projectId,
    documentId,
    userId,
    userEmail,
    folder_id,
  });
  if (!result.ok) {
    if (result.kind === "forbidden")
      return void res.status(404).json({ detail: "Project not found" });
    if (result.kind === "folder_not_found")
      return void res.status(404).json({ detail: "Folder not found" });
    return void res.status(404).json({ detail: "Document not found" });
  }
  res.json(result.doc);
});
