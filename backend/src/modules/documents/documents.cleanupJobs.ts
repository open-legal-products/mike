import { type Db, type DbJob, DbJobDeferredError } from "../../lib/dbq/types";
import { claimIdentity, settleClaim, type SettlementPatch } from "../../lib/dbq/claim";
import { safeError } from "../../lib/safeError";
import { jobErrorMessage } from "../../lib/dbq/jobError";
import { retryDelayMs, STALE_SECONDS } from "../../lib/dbq/runner";
import { requestDocumentCleanupDelivery } from "../../lib/dbq/enqueue";
import { logError } from "../../lib/log";

import {
  assertStorageConfigured,
  deleteFile,
  extractedTextKey,
} from "../../lib/storage";

/**
 * How many sibling rows one run may absorb. The trigger writes one row per
 * mutated version, so deleting a project with a thousand documents produces
 * thousands of rows, and the poll loop claims five per tick — a drain
 * measured in hours (lc-01-drain.log). Coalescing turns that back into one
 * pass over one deduplicated key set, while every row keeps its own
 * done/failed outcome so retries stay per-row.
 */
const COALESCE_LIMIT = 500;

type ClaimedCleanupJob = Pick<
  DbJob,
  "id" | "payload" | "attempts" | "claimed_at"
>;

/** Deduplicate valid storage keys while ignoring malformed entries in a cleanup payload. */
function cleanupKeys(payload: DbJob["payload"] | undefined): string[] {
  const raw = payload?.keys;
  return [
    ...new Set(
      (Array.isArray(raw) ? raw : []).filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      ),
    ),
  ];
}

/**
 * Hand a coalesced row its own outcome, addressed to the claim we hold
 * (id + running + attempts + claimed_at) exactly like the runner's fence, so
 * this write cannot land on top of a reclaim by another runner.
 */
async function settleCoalescedJob(
  db: Db,
  row: ClaimedCleanupJob,
  outcome:
    | { done: true }
    | { done: false; message: string; runAt: string; refundAttempt?: boolean },
): Promise<void> {
  const patch: SettlementPatch = outcome.done
    ? {
        status: "done",
        finished_at: new Date().toISOString(),
        last_error: null,
      }
    : {
        status: "pending",
        run_at: outcome.runAt,
        last_error: outcome.message,
        ...(outcome.refundAttempt
          ? { attempts: Math.max(0, row.attempts - 1) }
          : {}),
      };
  const settlement = await settleClaim(db, claimIdentity(row), patch);
  // A transport exception is contained here, not caught by the surrounding
  // cleanup body and misclassified as another delete/retry for every sibling.
  if (settlement.kind === "outcome_unknown")
    logError("dbq/document-cleanup", new Error(`settlement_${safeError(settlement.error).category}`), { jobId: row.id });

}

/** Claim the pending cleanup backlog so one run can drain all of it. */
async function claimSiblingCleanupJobs(
  db: Db,
  selfId: string,
): Promise<ClaimedCleanupJob[]> {
  const { data, error } = await db.rpc("claim_db_jobs", {
    p_limit: COALESCE_LIMIT,
    p_stale_seconds: STALE_SECONDS,
    p_kind: "document.cleanup",
  });
  if (error) {
    // A database without the kind-filtered claim (code ahead of migration)
    // drains one row per job: slower, never wrong.
    logError("dbq/document-cleanup", error, { phase: "coalesce" });
    return [];
  }
  const siblings: ClaimedCleanupJob[] = [];
  for (const row of (data ?? []) as DbJob[]) {
    if (row.id === selfId) continue;
    if (row.kind !== "document.cleanup") {
      // Defensive: a claim that ignored the filter must not strand another
      // kind's row in `running` until the stale threshold expires.
      await settleCoalescedJob(db, row, {
        done: false,
        message: "released by document.cleanup coalescing",
        runAt: new Date().toISOString(),
        refundAttempt: true,
      });
      continue;
    }
    siblings.push(row);
  }
  return siblings;
}

/** The database trigger owns enqueueing; all deletion surfaces use this job. */
export async function handleDocumentCleanup(
  db: Db,
  job: Pick<DbJob, "payload"> & Partial<Pick<DbJob, "id">>,
): Promise<void> {
  // Only a genuinely claimed row may claim siblings: the inline fallback
  // below passes a synthetic job and owns nothing in db_jobs.
  const siblings = job.id ? await claimSiblingCleanupJobs(db, job.id) : [];
  const ownKeys = cleanupKeys(job.payload);
  const keys = [
    ...new Set([
      ...ownKeys,
      ...siblings.flatMap((row) => cleanupKeys(row.payload)),
    ]),
  ];
  if (!keys.length) {
    for (const row of siblings)
      await settleCoalescedJob(db, row, { done: true });
    return;
  }
  try {
    await deleteCleanupKeys(db, keys, ownKeys, siblings);
  } catch (err) {
    // This row's outcome belongs to the runner, but the rows we claimed are
    // ours to hand back — otherwise they wait out the stale threshold.
    const deferred = err instanceof DbJobDeferredError;
    for (const row of siblings)
      await settleCoalescedJob(db, row, {
        done: false,
        // The same reason the runner records for the row it owns; siblings
        // must not be left with a placeholder while the owner keeps the cause.
        message: jobErrorMessage(err, "cleanup_failed"),
        runAt: deferred
          ? err.runAt
          : new Date(Date.now() + retryDelayMs(row.attempts)).toISOString(),
        refundAttempt: deferred,
      });
    throw err;
  }
}

/**
 * One pass over the merged key set. Failures are attributed back to the row
 * that asked for each key, so a storage object that keeps rejecting deletes
 * only retries its own row.
 */
async function deleteCleanupKeys(
  db: Db,
  keys: string[],
  ownKeys: string[],
  siblings: ClaimedCleanupJob[],
): Promise<void> {
  assertStorageConfigured();
  // A precompute worker may already hold source bytes when deletion commits.
  // Wait for its claim to finish before removing its output, including a
  // worker that fails after uploading. Pending jobs check liveness before
  // writing, so they cannot recreate a deleted version's cache.
  const cacheVersions = keys
    .filter((key) => key.startsWith("extracted-text/") && key.endsWith(".txt"))
    .map((key) => key.slice("extracted-text/".length, -4));
  if (cacheVersions.length) {
    const { data, error } = await db.rpc("document_cache_writer_active", {
      p_version_ids: cacheVersions,
    });
    if (error) throw error;
    if (data === true)
      throw new DbJobDeferredError(
        new Date(Date.now() + 10_000).toISOString(),
        "document_cache_writer_active",
      );
  }
  // Legacy data can share object paths. Never delete bytes a surviving
  // version still references, and fail closed if the lookup fails.
  //
  // Both lookups are RPCs so the key list travels in the POST body. A
  // coalesced run carries hundreds of keys, and a PostgREST `in(...)` filter
  // puts every one of them in the request URL: the deployment gateway
  // answered 414 at about 100 ordinary paths, so the run failed before
  // deleting anything and each retry rebuilt the same oversized batch.
  const referenced = new Set<string>();
  const { data: referencedRows, error: referencedError } = await db.rpc(
    "document_cleanup_referenced_keys",
    { p_keys: keys },
  );
  if (referencedError) throw referencedError;
  for (const row of (referencedRows ?? []) as { key?: unknown }[]) {
    if (typeof row.key === "string") referenced.add(row.key);
  }
  const failed = new Set<string>();
  for (const key of keys) {
    if (referenced.has(key)) continue;
    try {
      await deleteFile(key);
    } catch {
      failed.add(key);
    }
  }
  for (const row of siblings) {
    const rowFailures = cleanupKeys(row.payload).filter((key) =>
      failed.has(key),
    ).length;
    await settleCoalescedJob(
      db,
      row,
      rowFailures
        ? {
            done: false,
            message: `document_cleanup_failed:${rowFailures}`,
            runAt: new Date(
              Date.now() + retryDelayMs(row.attempts),
            ).toISOString(),
          }
        : { done: true },
    );
  }
  const ownFailures = ownKeys.filter((key) => failed.has(key)).length;
  if (ownFailures) throw new Error(`document_cleanup_failed:${ownFailures}`);
}

/** Operational queue-disable fallback. Normally the trigger is the only
 * collector. With workers explicitly disabled, retain a request-local copy
 * so erasure still removes bytes inline; the trigger remains the durable retry
 * record if storage fails. Callers must authorize the supplied scope first.
 *
 * BEST-EFFORT, ALWAYS. This runs BEFORE the rows are deleted, so anything it
 * throws cancels a delete the user asked for and is allowed to have. An
 * unconfigured object store or a failed lookup costs us the inline snapshot,
 * nothing more: the trigger still records the cleanup intent, and a runner
 * picks it up whenever one exists again. */
export async function captureInlineDocumentCleanup(
  db: Db,
  scope:
    | { documentIds: string[] }
    | { versionIds: string[] }
    | { projectIds: string[] }
    | { workflowId: string },
): Promise<string[]> {
  if (process.env.DB_JOBS_ENABLED !== "false") return [];
  try {
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
    // `in(...)` travels in the request URL; 50 uuids stay well under the
    // gateway's limit (500 did not — see deleteCleanupKeys).
    for (let start = 0; start < ids.length; start += 50) {
      const { data, error } = await db
        .from("document_versions")
        .select("id, storage_path, pdf_storage_path")
        .in(
          "versionIds" in scope ? "id" : "document_id",
          ids.slice(start, start + 50),
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
  } catch (err) {
    logError("documents/inline-cleanup", err, { phase: "capture" });
    return [];
  }
}

/**
 * Close out a delete's cleanup. Two halves, and normal deployments only use
 * the second: inline deletion for the queue-disabled fallback, then a
 * delivery request for the rows the version trigger just wrote, so a Redis
 * deployment starts draining in milliseconds instead of at the next 60s poll.
 *
 * NEVER THROWS. Every caller runs this AFTER the rows are gone. The job form
 * of this work signals a retry by throwing — that is how the runner knows to
 * come back — but on a request thread the same throw turns a completed delete
 * into a 500 and, on the account-erasure path, abandons the cascade partway
 * through. The db_jobs row the trigger wrote is the durable record, so
 * logging and continuing loses nothing but the head start.
 */
export async function completeInlineDocumentCleanup(
  db: Db,
  keys: string[],
): Promise<void> {
  if (keys.length) {
    try {
      await handleDocumentCleanup(db, { payload: { keys } });
    } catch (err) {
      logError("documents/inline-cleanup", err, {
        phase: "complete",
        keys: keys.length,
      });
    }
  }
  await requestDocumentCleanupDelivery(db);
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
  // Same best-effort rule as the scoped capture above: this runs before the
  // write it snapshots, so it must never be the reason the write is refused.
  if (error) {
    logError("documents/inline-cleanup", error, { phase: "capture-version" });
    return [];
  }
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
