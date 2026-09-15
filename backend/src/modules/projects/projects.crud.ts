// Project CRUD service functions: overview, create, detail, people, update,
// delete, and the tamper-evident export manifest.

import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import {
  buildProjectExportManifest,
  projectManifestFilename,
} from "../user/user.service";
import {
  checkProjectAccess,
  getOrgRole,
  listUserOrgIds,
} from "../../lib/access";
import { can } from "../../lib/permissions";
import {
  listProjectAdminContacts,
  listProjectGrants,
} from "../../lib/projectAccess";
import { listOrgAccessPeople } from "../../lib/orgAccessOverrides";
import { deleteProjectsByIds } from "../user/user.service";
import { loadProfileUsersByEmail } from "../../lib/userLookup";
import { ensureResourceAccessSummaries } from "../../lib/resourceAccessSummary";
import {
  buildProjectIdsOverviewRpcArgs,
  buildProjectsOverviewRpcArgs,
  type ProjectScope,
} from "./projects.overview";
import {
  type Db,
  attachDocumentOwnerLabels,
  attachProjectMemoryEnabled,
  normalizeOptionalString,
  projectMemoryDefaultFor,
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

  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "project",
    (data ?? []) as { id: string }[],
  );
  if (accessSummary.error) return { ok: false, error: accessSummary.error };
  const withMemory = await attachProjectMemoryEnabled(db, accessSummary.rows);
  if (withMemory.error) return { ok: false, error: withMemory.error };
  const projects = withMemory.rows;
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
  const withMemory = await attachProjectMemoryEnabled(
    db,
    (data ?? []) as { id: string }[],
  );
  if (withMemory.error) return { ok: false, error: withMemory.error };
  return { ok: true, data: withMemory.rows };
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
    // Direct access now lives in project_access_grants (one row per
    // recipient, with a role) rather than the roleless shared_with array, so
    // the picker resolves ids first and then loads those projects.
    const { data: grantRows } = await db
      .from("project_access_grants")
      .select("project_id")
      .eq("email", normalizedUserEmail);
    const grantedProjectIds = [
      ...new Set(
        ((grantRows ?? []) as { project_id?: string | null }[])
          .map((row) => row.project_id)
          .filter((id): id is string => !!id),
      ),
    ];
    if (grantedProjectIds.length > 0) {
      projectQueries.push(
        db.from("projects").select("*").in("id", grantedProjectIds),
      );
    }
  }
  // Third access branch (multi-tenant): projects in an org the caller belongs
  // to are searchable, mirroring listAccessibleProjectIds and the overview
  // RPCs — otherwise the document picker would hide org content the project
  // list shows.
  const orgIds = await listUserOrgIds(userId, db);
  if (orgIds.length > 0) {
    projectQueries.push(db.from("projects").select("*").in("org_id", orgIds));
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
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function createProject(
  db: Db,
  args: {
    userId: string;
    name: string;
    cm_number?: string;
    practice?: string;
    org_id?: string | null;
    memory_enabled?: boolean;
  },
): Promise<CreateProjectResult> {
  const { userId, name, cm_number, practice, org_id, memory_enabled } = args;
  if (!name?.trim())
    return { ok: false, kind: "validation", detail: "name is required" };
  if (memory_enabled !== undefined && typeof memory_enabled !== "boolean") {
    return {
      ok: false,
      kind: "validation",
      detail: "memory_enabled must be a boolean",
    };
  }

  // Tenant assignment: an explicit org_id must be one the caller belongs to.
  // No org_id means a personal project — org_id stays NULL, which is the
  // whole representation of "personal" now that hidden personal orgs are gone.
  let resolvedOrgId: string | null = null;
  if (org_id) {
    const role = await getOrgRole(userId, org_id, db);
    if (!role)
      return {
        ok: false,
        kind: "validation",
        detail: "You are not a member of that organization.",
      };
    resolvedOrgId = org_id;
  }

  const resolvedMemoryEnabled =
    memory_enabled ?? (await projectMemoryDefaultFor(db, userId));
  // The explicit opt-in/out and the project row are one transaction. A crash
  // can never leave an opted-out project without its fail-closed setting.
  const { data: created, error } = await db.rpc("create_project_with_memory", {
    p_user_id: userId,
    p_name: name.trim(),
    p_cm_number: normalizeOptionalString(cm_number),
    p_practice: normalizeOptionalString(practice),
    p_org_id: resolvedOrgId,
    p_memory_enabled: resolvedMemoryEnabled,
  });
  const data = Array.isArray(created) ? created[0] : created;
  if (error || !data) return { ok: false, kind: "db_error", error };
  return {
    ok: true,
    project: {
      ...data,
      memory_enabled: resolvedMemoryEnabled,
      documents: [],
      is_owner: true,
      access_role: "owner",
      access_scope: resolvedOrgId ? "organization" : "private",
      organization_name: null,
    },
  };
}

export type ProjectDetailResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function getProjectDetail(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<ProjectDetailResult> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "not_found" };

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project) return { ok: false, kind: "not_found" };

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
  // Contact details for the "you can't do that" popups. Without them the UI
  // can tell a viewer they were refused but never who to ask.
  const adminContacts = await listProjectAdminContacts(db, access.project);
  const creatorContact =
    adminContacts.find((c) => c.source === "creator") ?? null;
  const withMemory = await attachProjectMemoryEnabled(db, [
    project as { id: string; memory_enabled?: boolean },
  ]);
  if (withMemory.error) return { ok: false, kind: "db_error", error: withMemory.error };
  return {
    ok: true,
    body: {
      ...withMemory.rows[0],
      is_owner: access.isCreator,
      access_role: access.projectRole,
      org_role: access.orgRole,
      owner_email: creatorContact?.email ?? null,
      owner_display_name: creatorContact?.display_name ?? null,
      admin_contacts: adminContacts,
      documents: docsTyped,
      folders: folderData ?? [],
    },
  };
}

export type ProjectPeopleResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function getProjectPeople(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<ProjectPeopleResult> {
  const { projectId, userId, userEmail } = args;

  // Visible to anyone who can see the project, at every tier. "Who else is on
  // this matter?" is part of working on it even for a viewer, and the access
  // modal shows the same roster to everyone rather than a different one per
  // role. This deliberately matches GET /chat/:chatId/people and
  // GET /tabular-review/:reviewId/people, which resolve a project-owned row
  // through this same roster: tiering it here and not there only meant the
  // list was one request away.
  //
  // Note the split that remains: the roster is readable, but the MANAGEMENT
  // surface (GET /:projectId/access — who granted what, and the role pickers)
  // still requires `access.manage`.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "not_found" };
  const project = access.project;

  if (project.org_id) {
    const listed = await listOrgAccessPeople(db, {
      kind: "project",
      resourceId: projectId,
      orgId: project.org_id,
      creatorId: project.user_id,
    });
    if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
    const creator = listed.people.find(
      (person) => person.user_id === project.user_id,
    );
    return {
      ok: true,
      body: {
        scope: "organization",
        owner: creator
          ? {
              user_id: creator.user_id,
              email: creator.email,
              display_name: creator.display_name,
              role: "owner" as const,
            }
          : null,
        members: listed.people.filter(
          (person) => person.user_id !== project.user_id,
        ),
        admin_contacts: await listProjectAdminContacts(db, project),
      },
    };
  }

  // Personal projects keep email-addressed direct grants.
  const { userByEmail, userById } = await loadProfileUsersByEmail(db);

  const ownerInfo = project.user_id
    ? userById.get(project.user_id)
    : undefined;
  // `owner` is the project's creator. It can be null now: an organization
  // project outlives the account that created it, and the org's admins
  // administer it from then on.
  const owner = project.user_id
    ? {
        user_id: project.user_id,
        email: ownerInfo?.email ?? null,
        display_name: ownerInfo?.display_name ?? null,
        role: "owner" as const,
      }
    : null;
  const listed = await listProjectGrants(db, projectId);
  if (!listed.ok) return { ok: false, kind: "db_error", error: listed.detail };
  const members = listed.grants.map((grant) => ({
    email: grant.email,
    display_name: userByEmail.get(grant.email)?.display_name ?? null,
    role: grant.role,
  }));

  return {
    ok: true,
    body: {
      scope: "direct",
      owner,
      members,
      admin_contacts: await listProjectAdminContacts(db, project),
    },
  };
}

export type UpdateProjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "forbidden"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

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
  // Project settings and access edits are Owner-only: the creator, a direct
  // Owner grant on a personal project, or an Admin of the project's org.
  // The user_id filter moves out of the UPDATE so Owners can act on rows they
  // did not create.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "not_found" };
  if (!can(access.projectRole, "access.manage"))
    return {
      ok: false,
      kind: "forbidden",
      detail: "Only a project owner can change project settings.",
    };

  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
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
  const withMemory = await attachProjectMemoryEnabled(db, [
    data as { id: string; memory_enabled?: boolean },
  ]);
  if (withMemory.error)
    return { ok: false, kind: "db_error", error: withMemory.error };
  return {
    ok: true,
    body: {
      ...withMemory.rows[0],
      documents: docsTyped,
      folders: folderData ?? [],
    },
  };
}

export type DeleteProjectResult =
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "forbidden"; detail: string }
  | { ok: false; kind: "error"; error: unknown };

export async function deleteProject(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<DeleteProjectResult> {
  const { projectId, userId, userEmail } = args;
  // Deleting a project is the destructive end of the ladder, so it declares
  // `container.delete` like every other gate on this branch instead of
  // leaning on the cascade helper's `.eq("user_id", …)` filter to imply the
  // rule. Same verdict, stated where a reader looks for it — and the two
  // failure modes stop being one indistinguishable 404: a stranger still
  // gets "not found", while a member or viewer who CAN see the project is
  // told they were refused.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "not_found" };
  if (!can(access.projectRole, "container.delete"))
    return {
      ok: false,
      kind: "forbidden",
      detail: "Only a project owner can delete this project.",
    };
  try {
    // Delete by id, not by owner: the capability check above is what
    // authorises this, and an organization project may have no creator left
    // to scope by (user_id goes NULL when that account is deleted).
    const deletedCount = await deleteProjectsByIds(db, [projectId]);
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
