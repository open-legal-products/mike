// documentMaintenance — implementation behind the module facade.
// Stale-work reaper: flips transient statuses that lost their owner to a
// terminal "error" so the UI never shows an eternal spinner.
//
// Transient statuses ("processing" documents, "generating" tabular cells) are
// normally resolved by the request that set them or by a queue worker. A crash
// in the wrong window strands them: the request died mid-pipeline, or a job
// was lost between the status write and the enqueue. Nothing else ever
// resolves them — this sweep is the missing owner of last resort.
//
// Safety model:
// - Documents are age-gated on updated_at (STALE_DOC_PROCESSING_MS, default
//   30 min) so an in-flight synchronous upload is never touched, and — when
//   the conversion queue is enabled — a document whose conversion job still
//   exists in the queue is skipped regardless of age.
// - Cells have no updated_at column, so their sweep runs ONLY when the
//   extraction queue is enabled, where "generating with no live job" is
//   sufficient evidence of orphanhood (sync-mode in-flight work cannot be
//   distinguished from a stranded cell without an age signal, so sync
//   deployments keep today's behavior: a stuck cell is fixed by re-clicking).
// - A cell is additionally protected by its review's GENERATION LEASE: while
//   the review still holds an unexpired lease, some holder (the request that
//   claimed it, or a worker renewing it) is alive by definition and owns the
//   cell's terminal state. Only a review whose lease lapsed — or was never
//   held — can have orphans. That also closes the window between the route
//   stamping a cell and its enqueue landing in Redis, where no job exists yet.
// - Flipping a cell goes through `finalizeCell`, the one guarded terminal
//   writer: it clears `generation_id`, and for a stamped cell it matches only
//   while the cell still carries that stamp. Clearing the stamp is also what
//   lets the dead run's lease go, so the sweep calls `finishGenerationIfIdle`
//   once per generation it touched.
import { createServerSupabase, type Db } from "../../lib/supabase";
import { getConversionQueue, conversionJobId } from "../../lib/queue/conversionQueue";
import { withRedisTimeout } from "../../lib/queue/connection";
import { redisEnabled } from "../../lib/dbq/driver";
import { liveDbJobExists } from "../../lib/dbq/enqueue";

const DEFAULT_DOC_STALE_MS = 30 * 60 * 1000;

function docStaleMs(): number {
    const raw = Number(process.env.STALE_DOC_PROCESSING_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DOC_STALE_MS;
}

/**
 * Flip documents stuck in "processing" past the age threshold to "error",
 * skipping any that still have a live conversion job.
 */
export async function sweepStaleProcessingDocuments(
    db: Db = createServerSupabase(),
): Promise<number> {
    const cutoff = new Date(Date.now() - docStaleMs()).toISOString();
    const { data: docs, error } = await db
        .from("documents")
        .select("id, current_version_id")
        .eq("status", "processing")
        .lt("updated_at", cutoff);
    if (error) {
        console.error("[stale-sweep] documents query failed", error);
        return 0;
    }

    const queueOn = process.env.ASYNC_DOCUMENT_CONVERSION === "true";
    const rows = (docs ?? []) as {
        id: string;
        current_version_id?: string | null;
    }[];

    // A conversion job's id is keyed on (version, storage key), so liveness
    // has to be asked about the file the version currently holds. That is also
    // the semantically right question: a job still carrying a SUPERSEDED
    // storage key can no longer finalize this document — the worker's write is
    // fenced on the version's current storage_path — so it must not count as
    // the owner keeping the document alive.
    const storagePathByVersion = new Map<string, string>();
    const versionIds = queueOn
        ? rows
              .map((d) => d.current_version_id)
              .filter((id): id is string => !!id)
        : [];
    if (versionIds.length) {
        const { data: versions } = await db
            .from("document_versions")
            .select("id, storage_path")
            .in("id", versionIds);
        for (const v of (versions ?? []) as {
            id: string;
            storage_path?: string | null;
        }[])
            if (v.storage_path) storagePathByVersion.set(v.id, v.storage_path);
    }

    let flipped = 0;
    for (const doc of rows) {
        const storagePath = doc.current_version_id
            ? storagePathByVersion.get(doc.current_version_id)
            : undefined;
        if (queueOn && doc.current_version_id && storagePath) {
            // A job that still exists (waiting/active/delayed) owns this
            // document; terminal jobs are removed immediately (BullMQ) or
            // freed from the dedupe index (DB queue), so existence is the
            // liveness signal on either driver.
            const jobId = conversionJobId(doc.current_version_id, storagePath);
            const live = redisEnabled()
                ? !!(await withRedisTimeout("conversion job lookup", () =>
                      getConversionQueue().getJob(jobId),
                  ))
                : await liveDbJobExists(db, jobId);
            if (live) continue;
        }
        const { error: updateErr } = await db
            .from("documents")
            .update({ status: "error", updated_at: new Date().toISOString() })
            .eq("id", doc.id)
            .eq("status", "processing");
        if (updateErr) {
            console.error("[stale-sweep] document flip failed", {
                documentId: doc.id,
                error: updateErr,
            });
            continue;
        }
        flipped += 1;
        console.warn(
            "[stale-sweep] stale processing document flipped to error",
            { documentId: doc.id },
        );
    }
    return flipped;
}
