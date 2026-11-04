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
import { liveDbJobDedupeKeys } from "../../lib/dbq/enqueue";
import { chunkArray } from "../../lib/arrays";
import { ID_FILTER_BATCH_SIZE, selectInBatches } from "../../lib/batchedQuery";
import { mapWithConcurrency } from "../../lib/concurrency";

const DEFAULT_DOC_STALE_MS = 30 * 60 * 1000;
/** Documents judged per sweep; a larger backlog is visited over later sweeps. */
const STALE_DOC_SWEEP_LIMIT = 500;
/**
 * Where the next sweep resumes: the last document id the previous sweep
 * judged (null = start of a pass). Process-local by design: a restart only
 * starts a new pass from the beginning, and each process cycles on its own.
 */
let staleDocCursor: string | null = null;

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
    // Bounded per sweep, and fair: a keyset scan on the unique id that
    // resumes where the last sweep stopped. Re-reading the oldest page every
    // time would park an orphan forever behind a page of documents whose
    // conversions are still live (they stay "processing" and keep their
    // place). Every candidate is judged once per pass of
    // ceil(candidates / STALE_DOC_SWEEP_LIMIT) sweeps; a document that turns
    // stale mid-pass is reached by the next pass at the latest.
    const page = (after: string | null) => {
        let query = db
            .from("documents")
            .select("id, current_version_id")
            .eq("status", "processing")
            .lt("updated_at", cutoff);
        if (after) query = query.gt("id", after);
        return query.order("id", { ascending: true }).limit(STALE_DOC_SWEEP_LIMIT);
    };
    let { data: docs, error } = await page(staleDocCursor);
    if (!error && staleDocCursor && !docs?.length) {
        // The pass is over: wrap around and start the next one now. (Only an
        // EMPTY page ends a pass; a gateway max_rows below the limit returns
        // short pages that are not the end.)
        staleDocCursor = null;
        ({ data: docs, error } = await page(null));
    }
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
    let stale: string[];
    try {
        const storagePathByVersion = new Map<string, string>();
        if (queueOn) {
            const versions = await selectInBatches<{ id: string; storage_path?: string | null }>(
                "stale document versions",
                rows.map((d) => d.current_version_id),
                (batch) => db.from("document_versions").select("id, storage_path").in("id", batch),
            );
            for (const v of versions)
                if (v.storage_path) storagePathByVersion.set(v.id, v.storage_path);
        }
        const jobIdByDoc = new Map<string, string>();
        for (const doc of rows) {
            const storagePath = doc.current_version_id
                ? storagePathByVersion.get(doc.current_version_id)
                : undefined;
            if (queueOn && doc.current_version_id && storagePath)
                jobIdByDoc.set(doc.id, conversionJobId(doc.current_version_id, storagePath));
        }
        // A job that still exists (waiting/active/delayed) owns its document;
        // terminal jobs are removed immediately (BullMQ) or freed from the
        // dedupe index (DB queue), so existence is the liveness signal on
        // either driver. Asked for the whole page at once (DB queue: one
        // query per 50 keys) or a few at a time (BullMQ), not serially.
        const jobIds = [...jobIdByDoc.values()];
        const live = new Set<string>();
        if (redisEnabled()) {
            const found = await mapWithConcurrency(jobIds, 8, async (jobId) =>
                (await withRedisTimeout("conversion job lookup", () =>
                    getConversionQueue().getJob(jobId),
                ))
                    ? jobId
                    : null,
            );
            for (const jobId of found) if (jobId) live.add(jobId);
        } else {
            for (const batch of chunkArray(jobIds, ID_FILTER_BATCH_SIZE))
                for (const key of await liveDbJobDedupeKeys(db, batch)) live.add(key);
        }
        stale = rows
            .filter((doc) => !live.has(jobIdByDoc.get(doc.id) ?? ""))
            .map((doc) => doc.id);
    } catch (lookupError) {
        console.error("[stale-sweep] liveness lookup failed", lookupError);
        return 0;
    }
    // Judged: the next sweep resumes after this page (a failed lookup above
    // retries the same page).
    staleDocCursor = rows.length ? rows[rows.length - 1].id : null;

    let flipped = 0;
    for (const batch of chunkArray(stale, ID_FILTER_BATCH_SIZE)) {
        const { data: updated, error: updateErr } = await db
            .from("documents")
            .update({ status: "error", updated_at: new Date().toISOString() })
            .in("id", batch)
            .eq("status", "processing")
            .select("id");
        if (updateErr) {
            console.error("[stale-sweep] document flip failed", {
                documentIds: batch.length,
                error: updateErr,
            });
            continue;
        }
        for (const row of (updated ?? []) as { id: string }[]) {
            flipped += 1;
            console.warn(
                "[stale-sweep] stale processing document flipped to error",
                { documentId: row.id },
            );
        }
    }
    return flipped;
}
