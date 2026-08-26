// Shared types + helpers for the projects module service layer.
//
// The projects service is split by concern across sibling files
// (projects.crud.ts, projects.documents.ts, projects.folders.ts,
// projects.chats.ts). Anything used by more than one of them lives here, and
// projects.service.ts re-exports the whole surface so route/test importers see
// a single module.

import { createServerSupabase } from "../../lib/supabase";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";

export type Db = ReturnType<typeof createServerSupabase>;

export function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

// Normalise a `shared_with` email list: lowercase + dedupe + drop empties.
// Returns `{ ok: false, self: true }` when the caller's own email appears in
// the list — POST /projects and PATCH /projects/:projectId previously carried
// identical copies of this loop inline and both surface that case as a 400.
export function normalizeSharedWith(
  raw: unknown,
  normalizedUserEmail: string | undefined,
): { ok: true; cleaned: string[] } | { ok: false; self: true } {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value !== "string") continue;
      const e = value.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      if (normalizedUserEmail && e === normalizedUserEmail) {
        return { ok: false, self: true };
      }
      seen.add(e);
      cleaned.push(e);
    }
  }
  return { ok: true, cleaned };
}

export async function deleteProjectDocumentsAndVersionFiles(
  db: Db,
  projectId: string,
  documentIds: string[],
) {
  if (documentIds.length === 0) return null;
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", documentIds);
  if (versionsError) return versionsError;

  const paths = new Set<string>();
  for (const v of versions ?? []) {
    if (typeof v.storage_path === "string" && v.storage_path.length > 0) {
      paths.add(v.storage_path);
    }
    if (typeof v.pdf_storage_path === "string" && v.pdf_storage_path.length > 0) {
      paths.add(v.pdf_storage_path);
    }
  }
  const { error } = await db
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);
  // Rows first, files second (durable storage.cleanup job) — previously each
  // file delete was fire-and-forget, so one storage hiccup leaked the bytes.
  if (!error) await enqueueStorageCleanup(db, [...paths]);
  return error ?? null;
}

export async function attachDocumentOwnerLabels(
  db: Db,
  docs: { user_id?: string | null }[],
) {
  const ownerIds = docs
    .map((doc) => doc.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (ownerIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", ownerIds);
  if (profilesError) {
    console.warn("[projects] failed to load document owner profiles", profilesError);
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
  const creatorIds = chats
    .map((chat) => chat.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (creatorIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", creatorIds);
  if (profilesError) {
    console.warn("[projects] failed to load chat creator profiles", profilesError);
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
