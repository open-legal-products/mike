import { type Db, type DbJob, DbJobDeferredError } from "../../lib/dbq/types";

import {
  assertStorageConfigured,
  deleteFile,
  extractedTextKey,
} from "../../lib/storage";

/** The database trigger owns enqueueing; all deletion surfaces use this job. */
export async function handleDocumentCleanup(
  db: Db,
  job: Pick<DbJob, "payload">,
): Promise<void> {
  const keys = [
    ...new Set(
      (Array.isArray(job.payload.keys) ? job.payload.keys : []).filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      ),
    ),
  ];
  if (!keys.length) return;
  assertStorageConfigured();
  // A precompute worker may already hold source bytes when deletion commits.
  // Wait for its claim to finish before removing its output, including a
  // worker that fails after uploading. Pending jobs check liveness before
  // writing, so they cannot recreate a deleted version's cache.
  const cacheVersions = keys
    .filter((key) => key.startsWith("extracted-text/") && key.endsWith(".txt"))
    .map((key) => key.slice("extracted-text/".length, -4));
  for (let start = 0; start < cacheVersions.length; start += 500) {
    const { data, error } = await db
      .from("db_jobs")
      .select("id")
      .eq("kind", "document.precompute_text")
      .eq("status", "running")
      .in("payload->>versionId", cacheVersions.slice(start, start + 500))
      .limit(1);
    if (error) throw error;
    if (data?.length)
      throw new DbJobDeferredError(
        new Date(Date.now() + 10_000).toISOString(),
        "document_cache_writer_active",
      );
  }
  // Legacy data can share object paths. Never delete bytes a surviving
  // version still references, and fail closed if either lookup fails.
  const referenced = new Set<string>();
  for (const column of ["storage_path", "pdf_storage_path"] as const) {
    const { data, error } = await db
      .from("document_versions")
      .select(column)
      .in(column, keys)
      .is("deleted_at", null);
    if (error) throw error;
    for (const row of data ?? []) {
      const key = (row as unknown as Record<string, unknown>)[column];
      if (typeof key === "string") referenced.add(key);
    }
  }
  let failures = 0;
  for (const key of keys) {
    if (referenced.has(key)) continue;
    try {
      await deleteFile(key);
    } catch {
      failures++;
    }
  }
  if (failures) throw new Error(`document_cleanup_failed:${failures}`);
}

/** Operational queue-disable fallback. Normally the trigger is the only
 * collector. With workers explicitly disabled, retain a request-local copy
 * so erasure still removes bytes inline; the trigger remains the durable retry
 * record if storage fails. Callers must authorize the supplied scope first. */
export async function captureInlineDocumentCleanup(
  db: Db,
  scope:
    | { documentIds: string[] }
    | { versionIds: string[] }
    | { projectIds: string[] }
    | { workflowId: string },
): Promise<string[]> {
  if (process.env.DB_JOBS_ENABLED !== "false") return [];
  assertStorageConfigured();
  let ids: string[];
  if ("documentIds" in scope) ids = scope.documentIds;
  else if ("versionIds" in scope) ids = scope.versionIds;
  else {
    const query = db.from("documents").select("id");
    const { data, error } =
      "projectIds" in scope
        ? await query.in("project_id", scope.projectIds)
        : await query.eq("workflow_id", scope.workflowId);
    if (error) throw error;
    ids = (data ?? []).map((row) => row.id as string);
  }
  const keys = new Set<string>();
  for (let start = 0; start < ids.length; start += 500) {
    const { data, error } = await db
      .from("document_versions")
      .select("id, storage_path, pdf_storage_path")
      .in(
        "versionIds" in scope ? "id" : "document_id",
        ids.slice(start, start + 500),
      );
    if (error) throw error;
    for (const row of data ?? []) {
      for (const key of [
        row.storage_path,
        row.pdf_storage_path,
        extractedTextKey(row.id),
      ]) {
        if (typeof key === "string" && key) keys.add(key);
      }
    }
  }
  return [...keys];
}

export async function completeInlineDocumentCleanup(
  db: Db,
  keys: string[],
): Promise<void> {
  if (keys.length) await handleDocumentCleanup(db, { payload: { keys } });
}

/** Mirror the trigger's retired-key selection only when workers are disabled.
 * The scoped snapshot happens before replacement; cleanup follows a successful
 * write and rechecks live references before removing source/rendition objects. */
export async function captureInlineVersionUpdateCleanup(
  db: Db,
  documentId: string,
  versionId: string,
  patch: {
    storage_path?: string;
    pdf_storage_path?: string | null;
    content_sha256?: string | null;
  },
): Promise<string[]> {
  if (process.env.DB_JOBS_ENABLED !== "false") return [];
  if (
    !["storage_path", "pdf_storage_path", "content_sha256"].some((key) =>
      Object.hasOwn(patch, key),
    )
  )
    return [];
  const { data: previous, error } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path, content_sha256")
    .eq("id", versionId)
    .eq("document_id", documentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!previous) return [];
  const keys = new Set<string>();
  let invalidateCache = false;
  for (const column of ["storage_path", "pdf_storage_path"] as const) {
    if (patch[column] !== undefined && previous[column] !== patch[column]) {
      if (previous[column]) keys.add(previous[column]);
      if (column === "storage_path") invalidateCache = true;
    }
  }
  if (
    patch.content_sha256 !== undefined &&
    previous.content_sha256 !== patch.content_sha256
  )
    invalidateCache = true;
  if (invalidateCache) keys.add(extractedTextKey(versionId));
  return [...keys];
}
