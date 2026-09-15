// Shared types + helpers for the projects module service layer.
//
// The projects service is split by concern across sibling files
// (projects.crud.ts, projects.documents.ts, projects.folders.ts,
// projects.chats.ts). Anything used by more than one of them lives here, and
// projects.service.ts re-exports the whole surface so route/test importers see
// a single module.

import type { Db } from "../../lib/supabase";
export type { Db };
import { deleteCollectionDocuments } from "../documents/documents.service";

export function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function attachProjectMemoryEnabled<
  T extends { id: string; memory_enabled?: boolean },
>(db: Db, projects: T[]): Promise<{ rows: T[]; error: unknown | null }> {
  if (projects.length === 0) return { rows: projects, error: null };
  const { data, error } = await db
    .from("memory_files")
    .select("project_id, enabled")
    .eq("scope", "project")
    .in(
      "project_id",
      projects.map((project) => project.id),
    );
  if (error) return { rows: projects, error };
  const enabledByProject = new Map(
    (data ?? []).map((row) => [row.project_id as string, row.enabled === true]),
  );
  return {
    rows: projects.map((project) => ({
      ...project,
      // Creation writes the row atomically. Project memory is on by default,
      // so a project with no row yet (one predating the memory tables) reads
      // as enabled; an explicit opt-out is a stored `false`, not a gap.
      memory_enabled: enabledByProject.get(project.id) ?? true,
    })),
    error: null,
  };
}

/**
 * The creator's saved default for new projects' shared memory. A database
 * that has not applied the preference migration, or a profile row that has
 * not been created yet, falls back to on — the product default.
 */
export async function projectMemoryDefaultFor(
  db: Db,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("user_profiles")
    .select("project_memory_default")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return true;
  return (data as { project_memory_default?: unknown })
    .project_memory_default !== false;
}

export async function deleteProjectDocumentsAndVersionFiles(
  db: Db,
  projectId: string,
  documentIds: string[],
) {
  const result = await deleteCollectionDocuments(
    db, { kind: "project", projectId }, documentIds,
  );
  return result.ok ? null : result.kind === "error" ? result.error : result.detail;
}

// Shared core of the two attach*Labels helpers below: resolve the distinct
// user_ids on the rows to trimmed, non-empty display names. Lookup failures
// only warn — a missing label must never fail the listing that wanted it.
async function loadDisplayNamesByUserId(
  db: Db,
  rows: { user_id?: string | null }[],
  warnLabel: string,
): Promise<Map<string, string> | null> {
  const userIds = rows
    .map((row) => row.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (userIds.length === 0) return null;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", userIds);
  if (profilesError) {
    console.warn(`[projects] failed to load ${warnLabel}`, profilesError);
  }
  for (const profile of profiles ?? []) {
    const displayName =
      typeof profile.display_name === "string"
        ? profile.display_name.trim()
        : "";
    if (displayName) {
      displayNameByUserId.set(profile.user_id as string, displayName);
    }
  }
  return displayNameByUserId;
}

export async function attachDocumentOwnerLabels(
  db: Db,
  docs: { user_id?: string | null }[],
) {
  const displayNameByUserId = await loadDisplayNamesByUserId(
    db,
    docs,
    "document owner profiles",
  );
  if (!displayNameByUserId) return;

  for (const doc of docs as ({
    user_id?: string | null;
    owner_email?: string | null;
    owner_display_name?: string | null;
  })[]) {
    if (!doc.user_id) continue;
    doc.owner_email = null;
    doc.owner_display_name = displayNameByUserId.get(doc.user_id) ?? null;
  }
}

export async function attachChatCreatorLabels(
  db: Db,
  chats: { user_id?: string | null }[],
) {
  const displayNameByUserId = await loadDisplayNamesByUserId(
    db,
    chats,
    "chat creator profiles",
  );
  if (!displayNameByUserId) return;

  for (const chat of chats as ({
    user_id?: string | null;
    creator_display_name?: string | null;
  })[]) {
    if (!chat.user_id) continue;
    chat.creator_display_name = displayNameByUserId.get(chat.user_id) ?? null;
  }
}

export async function loadProjectFolder(
  db: Db,
  projectId: string,
  folderId: string,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("project_id", projectId)
    .maybeSingle();
  return (data as { id: string; parent_folder_id: string | null } | null) ?? null;
}
