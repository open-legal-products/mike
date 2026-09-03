// Project CRUD service functions: overview, create, detail, people, update,
// delete, and the tamper-evident export manifest.

import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import {
  buildProjectExportManifest,
  projectManifestFilename,
} from "../../lib/userDataExport";
import { checkProjectAccess } from "../../lib/access";
import { deleteUserProjects } from "../../lib/userDataCleanup";
import {
  findMissingUserEmails,
  loadProfileUsersByEmail,
} from "../../lib/userLookup";
import {
  buildProjectIdsOverviewRpcArgs,
  buildProjectsOverviewRpcArgs,
  type ProjectScope,
} from "./projects.overview";
import {
  type Db,
  attachDocumentOwnerLabels,
  normalizeOptionalString,
  normalizeSharedWith,
} from "./projects.shared";

// Service-layer failure carrying the raw driver error. The route layer hands
// it to sendInternalError, which logs it (with the request id) and answers
// with the generic internal-error body — no driver message reaches the client.
export type ProjectsDbFailure = { ok: false; error: unknown };

// Pass includeDocuments to also receive each project's documents in the
// same response. The directory pickers (useDirectoryData) previously fanned
// out one GET /projects/:id per project to obtain those documents; with N
// projects that burst — auth check plus several DB queries per request —
// could overwhelm the Supabase gateway. Batching keeps it at one request
// and a fixed number of queries regardless of project count.
// Pagination is opt-in (`filters` is only passed when the request carried
// pagination/search/sort/scope query params). ProjectsOverview.tsx sends
// them. Legacy tabular-review project pickers call this with no query params
// and must keep getting the full, unpaginated list, so callers must never
// default to paginating a request that didn't ask for it.
export type ProjectListFilters = {
  scope: ProjectScope;
  pagination: { limit: number; offset: number };
  searchTerm: string | null;
  sort: { key: string; direction: string };
  practice: string | null;
  ownerUserId: string | null;
};

export async function getProjectsOverview(
  db: Db,
  args: {
    userId: string;
    userEmail?: string;
    includeDocuments: boolean;
    filters?: ProjectListFilters;
  },
): Promise<{ ok: true; data: unknown } | ProjectsDbFailure> {
  const { userId, userEmail, includeDocuments, filters } = args;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();

  const rpcArgs = filters
    ? buildProjectsOverviewRpcArgs({
        userId,
        userEmail: normalizedUserEmail,
        scope: filters.scope,
        pagination: filters.pagination,
        searchTerm: filters.searchTerm,
        sort: filters.sort,
        practice: filters.practice,
        ownerUserId: filters.ownerUserId,
      })
    : { p_user_id: userId, p_user_email: normalizedUserEmail ?? null };

  const { data, error } = await db.rpc("get_projects_overview", rpcArgs);
  if (error) return { ok: false, error };

  const projects = (data ?? []) as { id: string }[];
  if (!includeDocuments || projects.length === 0) {
    return { ok: true, data: projects };
  }

  const projectIds = projects.map((p) => p.id);
  const [
    { data: docs, error: docsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
  ]);
  if (docsError) return { ok: false, error: docsError };
  if (foldersError) return { ok: false, error: foldersError };

  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    project_id?: string | null;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);

  const docsByProject = new Map<string, typeof docsTyped>();
  for (const doc of docsTyped) {
    if (!doc.project_id) continue;
    const bucket = docsByProject.get(doc.project_id);
    if (bucket) bucket.push(doc);
    else docsByProject.set(doc.project_id, [doc]);
  }
  const foldersByProject = new Map<string, NonNullable<typeof folders>>();
  for (const folder of folders ?? []) {
    const projectId = folder.project_id as string;
    const bucket = foldersByProject.get(projectId);
    if (bucket) bucket.push(folder);
    else foldersByProject.set(projectId, [folder]);
  }
  return {
    ok: true,
    data: projects.map((p) => ({
      ...p,
      documents: docsByProject.get(p.id) ?? [],
      folders: foldersByProject.get(p.id) ?? [],
    })),
  };
}

// Lightweight per-project summary rows for GET /projects?view=summary.
export async function getProjectSummaries(
  db: Db,
  args: {
    userId: string;
    userEmail?: string;
    pagination: { limit: number; offset: number };
  },
): Promise<{ ok: true; data: unknown } | ProjectsDbFailure> {
  const { userId, userEmail, pagination } = args;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const { data, error } = await db.rpc("get_project_summaries", {
    p_user_id: userId,
    p_user_email: normalizedUserEmail ?? null,
    p_limit: pagination.limit,
    p_offset: pagination.offset,
  });
  if (error) return { ok: false, error };
  return { ok: true, data: data ?? [] };
}

// GET /projects?view=directory-search
// Flat filename/project matches for the document picker. Search results do
// not pretend that a partially loaded project tree is a complete result set.
export async function searchProjectDirectory(
  db: Db,
  args: {
    userId: string;
    userEmail?: string;
    searchTerm: string;
    pagination: { limit: number; offset: number };
  },
): Promise<{ ok: true; data: unknown[] } | ProjectsDbFailure> {
  const { userId, userEmail, searchTerm, pagination } = args;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();

  const projectQueries = [
    db.from("projects").select("*").eq("user_id", userId),
  ];
  if (normalizedUserEmail) {
    projectQueries.push(
      db
        .from("projects")
        .select("*")
        .contains("shared_with", [normalizedUserEmail]),
    );
  }
  const projectResults = await Promise.all(projectQueries);
  const projectError = projectResults.find((result) => result.error)?.error;
  if (projectError) return { ok: false, error: projectError };
  const projectsById = new Map<string, Record<string, unknown>>();
  for (const result of projectResults) {
    for (const project of result.data ?? []) {
      projectsById.set(project.id as string, project);
    }
  }
  const accessibleProjectIds = [...projectsById.keys()];
  if (accessibleProjectIds.length === 0) return { ok: true, data: [] };

  const escaped = searchTerm.replace(/[%_]/g, (value) => `\\${value}`);
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("id")
    .ilike("filename", `%${escaped}%`)
    .is("deleted_at", null);
  if (versionsError) return { ok: false, error: versionsError };

  const versionIds = (versions ?? []).map((version) => version.id as string);
  let matchedDocuments: Record<string, unknown>[] = [];
  if (versionIds.length > 0) {
    const { data, error } = await db
      .from("documents")
      .select("*")
      .in("project_id", accessibleProjectIds)
      .in("current_version_id", versionIds);
    if (error) return { ok: false, error };
    matchedDocuments = (data ?? []) as Record<string, unknown>[];
    await attachLatestVersionNumbers(
      db,
      matchedDocuments as { id: string; current_version_id?: string | null }[],
    );
    await attachActiveVersionPaths(
      db,
      matchedDocuments as { id: string; current_version_id?: string | null }[],
    );
    await attachDocumentOwnerLabels(
      db,
      matchedDocuments as { user_id?: string | null }[],
    );
  }

  const normalized = searchTerm.toLowerCase();
  const documentProjectIds = new Set(
    matchedDocuments.map((document) => document.project_id as string),
  );
  const matches = [...projectsById.values()]
    .filter((project) => {
      const name = String(project.name ?? "").toLowerCase();
      const cmNumber = String(project.cm_number ?? "").toLowerCase();
      return (
        name.includes(normalized) ||
        cmNumber.includes(normalized) ||
        documentProjectIds.has(project.id as string)
      );
    })
    .sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    )
    .slice(pagination.offset, pagination.offset + pagination.limit + 1)
    .map((project) => ({
      ...project,
      is_owner: project.user_id === userId,
      documents: matchedDocuments.filter(
        (document) => document.project_id === project.id,
      ),
      folders: [],
    }));
  return { ok: true, data: matches };
}

// GET /projects/filter-options
export async function getProjectFilterOptions(
  db: Db,
  args: { userId: string; userEmail?: string },
): Promise<
  | {
      ok: true;
      body: {
        practices: string[];
        owners: { value: string; label: string }[];
      };
    }
  | ProjectsDbFailure
> {
  const { userId, userEmail } = args;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const { data, error } = await db.rpc("get_project_filter_options", {
    p_user_id: userId,
    p_user_email: normalizedUserEmail ?? null,
  });
  if (error) return { ok: false, error };

  const row = (data?.[0] ?? {}) as {
    practices?: unknown;
    owners?: unknown;
  };
  const practices = Array.isArray(row.practices)
    ? row.practices.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const owners = Array.isArray(row.owners)
    ? row.owners.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const option = value as { value?: unknown; label?: unknown };
        return typeof option.value === "string" &&
          typeof option.label === "string"
          ? [{ value: option.value, label: option.label }]
          : [];
      })
    : [];
  return { ok: true, body: { practices, owners } };
}

// GET /projects/ids
// Lightweight id + owner list for every project matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full project payloads just to collect checkboxes.
//
// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything this route asks for, and truncates silently
// rather than failing. So this pages through the RPC itself — server-side,
// same-datacenter round trips — until a page comes back empty, rather than
// trusting one call to return everything.
const PROJECT_IDS_PAGE_SIZE = 1000;
const PROJECT_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

export async function listProjectIds(
  db: Db,
  args: {
    userId: string;
    userEmail?: string;
    scope: ProjectScope;
    searchTerm: string | null;
    practice: string | null;
    ownerUserId: string | null;
  },
): Promise<
  | { ok: true; ids: { id: string; user_id: string }[] }
  | ProjectsDbFailure
> {
  const { userId, userEmail, scope, searchTerm, practice, ownerUserId } = args;

  const ids: { id: string; user_id: string }[] = [];
  let offset = 0;
  for (let page = 0; page < PROJECT_IDS_MAX_PAGES; page++) {
    const rpcArgs = buildProjectIdsOverviewRpcArgs({
      userId,
      userEmail,
      scope,
      searchTerm,
      practice,
      ownerUserId,
      pagination: { limit: PROJECT_IDS_PAGE_SIZE, offset },
    });
    const { data, error } = await db.rpc("get_project_ids_overview", rpcArgs);
    if (error) return { ok: false, error };

    const rows = (data ?? []) as { id: string; user_id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows);
    offset += rows.length;
  }

  return { ok: true, ids };
}

export type CreateProjectResult =
  | { ok: true; project: Record<string, unknown> }
  | { ok: false; kind: "validation" | "self_share"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function createProject(
  db: Db,
  args: {
    userId: string;
    userEmail?: string;
    name: string;
    cm_number?: string;
    practice?: string;
    shared_with?: string[];
  },
): Promise<CreateProjectResult> {
  const { userId, userEmail, name, cm_number, practice, shared_with } = args;
  if (!name?.trim())
    return { ok: false, kind: "validation", detail: "name is required" };
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const shared = normalizeSharedWith(shared_with, normalizedUserEmail);
  if (!shared.ok) {
    return {
      ok: false,
      kind: "self_share",
      detail: "You cannot share a project with yourself.",
    };
  }
  const cleanedSharedWith = shared.cleaned;

  const missingSharedUsers = await findMissingUserEmails(db, cleanedSharedWith);
  if (missingSharedUsers.length > 0) {
    return {
      ok: false,
      kind: "validation",
      detail: `${missingSharedUsers[0]} does not belong to a Mike user.`,
    };
  }

  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: normalizeOptionalString(cm_number),
      practice: normalizeOptionalString(practice),
      shared_with: cleanedSharedWith,
    })
    .select("*")
    .single();
  if (error) return { ok: false, kind: "db_error", error };
  return { ok: true, project: { ...data, documents: [] } };
}

export async function getProjectDetail(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false };

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project) return { ok: false };

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  return {
    ok: true,
    body: {
      ...project,
      is_owner: access.isOwner,
      documents: docsTyped,
      folders: folderData ?? [],
    },
  };
}

export async function getProjectPeople(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<
  | {
      ok: true;
      body: {
        owner: {
          user_id: unknown;
          email: string | null;
          display_name: string | null;
        };
        members: { email: string; display_name: string | null }[];
      };
    }
  | { ok: false }
> {
  const { projectId, userId, userEmail } = args;

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project) return { ok: false };

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared) return { ok: false };

  // Use the mirrored profile email so sharing checks do not scan auth.users.
  const { userByEmail, userById } = await loadProfileUsersByEmail(db);

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name: ownerInfo?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u?.display_name ?? null;
    return { email, display_name };
  });

  return { ok: true, body: { owner, members } };
}

export type UpdateProjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "self_share" | "missing_user"; detail: string }
  | { ok: false; kind: "not_found" };

export async function updateProject(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    userEmail?: string;
    body: Record<string, unknown>;
  },
): Promise<UpdateProjectResult> {
  const { projectId, userId, userEmail, body } = args;
  const updates: Record<string, unknown> = {};
  if (body.name != null) updates.name = body.name;
  if (body.cm_number != null) updates.cm_number = body.cm_number;
  if ("practice" in body) {
    updates.practice = normalizeOptionalString(body.practice);
  }
  if (Array.isArray(body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const normalizedUserEmail = userEmail?.trim().toLowerCase();
    const shared = normalizeSharedWith(body.shared_with, normalizedUserEmail);
    if (!shared.ok) {
      return {
        ok: false,
        kind: "self_share",
        detail: "You cannot share a project with yourself.",
      };
    }
    updates.shared_with = shared.cleaned;
  }

  if (Array.isArray(updates.shared_with)) {
    const missingSharedUsers = await findMissingUserEmails(
      db,
      updates.shared_with as string[],
    );
    if (missingSharedUsers.length > 0) {
      return {
        ok: false,
        kind: "missing_user",
        detail: `${missingSharedUsers[0]} does not belong to a Mike user.`,
      };
    }
  }

  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data) return { ok: false, kind: "not_found" };

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  return {
    ok: true,
    body: { ...data, documents: docsTyped, folders: folderData ?? [] },
  };
}

export async function deleteProject(
  db: Db,
  userId: string,
  projectId: string,
): Promise<
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error"; error: unknown }
> {
  try {
    const deletedCount = await deleteUserProjects(db, userId, [projectId]);
    if (deletedCount === 0) return { ok: false, kind: "not_found" };
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: "error", error: err };
  }
}

// Tamper-evident manifest of the project's documents: every version with its
// content_sha256 plus the accept/reject trail, under a SHA-256 digest that is
// Ed25519-signed when the deployment has MANIFEST_SIGNING_KEY set. To check an
// export, recompute a downloaded file's SHA-256 and compare, then check the
// manifest's signature against the key served at GET /manifest-signing-key.
// See the README.
export type ExportProjectResult =
  | { ok: true; data: unknown; filename: string }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "failed" };

export async function exportProjectManifest(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<ExportProjectResult> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  try {
    const data = await buildProjectExportManifest(db, projectId);
    return { ok: true, data, filename: projectManifestFilename(projectId) };
  } catch (err) {
    console.error("[projects/export] failed", {
      projectId,
      error: err,
    });
    return { ok: false, kind: "failed" };
  }
}
