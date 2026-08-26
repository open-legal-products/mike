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

import { createServerSupabase } from "../supabase";
import { logError } from "../log";
import { getConversionQueue, conversionJobId } from "../queue/conversionQueue";
import { getExtractionQueue, extractionJobId } from "../queue/extractionQueue";
import { finalizeCell } from "../../modules/tabular/tabular.extractRow";
import { finishGenerationIfIdle } from "../../modules/tabular/tabular.shared";
import { redisEnabled } from "../dbq/driver";
import { liveDbJobExists } from "../dbq/enqueue";

type Db = ReturnType<typeof createServerSupabase>;

const DEFAULT_DOC_STALE_MS = 30 * 60 * 1000;

// Cap one sweep's working set: the query is unbounded otherwise, and each cell
// costs a Redis lookup. Anything left over is picked up by the next sweep.
const MAX_GENERATING_CELLS_PER_SWEEP = 500;

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
    let flipped = 0;
    for (const doc of (docs ?? []) as {
        id: string;
        current_version_id?: string | null;
    }[]) {
        if (queueOn && doc.current_version_id) {
            // A job that still exists (waiting/active/delayed) owns this
            // document; terminal jobs are removed immediately (BullMQ) or
            // freed from the dedupe index (DB queue), so existence is the
            // liveness signal on either driver.
            const jobId = conversionJobId(doc.current_version_id);
            const live = redisEnabled()
                ? !!(await getConversionQueue().getJob(jobId))
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

/**
 * Is some holder still alive for this review's generation?
 *
 * The lease is the authoritative liveness signal for tabular work: a running
 * request or worker renews it well inside its window, so an unexpired lease
 * means someone owns the review's "generating" cells and will write their
 * terminal state. Fails SAFE — a lookup error reports "owned" rather than let
 * the sweep stomp a live run.
 */
async function hasActiveGenerationLease(
    db: Db,
    reviewId: string,
): Promise<boolean> {
    const { data, error } = await db
        .from("tabular_reviews")
        .select("active_generation_id, generation_lease_expires_at")
        .eq("id", reviewId)
        .maybeSingle();
    if (error) {
        console.error("[stale-sweep] review lease lookup failed", {
            reviewId,
            error,
        });
        return true;
    }
    const review = data as {
        active_generation_id?: string | null;
        generation_lease_expires_at?: string | null;
    } | null;
    if (!review?.active_generation_id || !review.generation_lease_expires_at)
        return false;
    const expiresAt = Date.parse(String(review.generation_lease_expires_at));
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Flip "generating" cells whose run has provably lost its owner to "error":
 * the review's generation lease has lapsed AND no extraction job still exists
 * for the cell. Only meaningful (and only run) when the extraction queue is
 * enabled — see the safety model above.
 */
export async function sweepStaleGeneratingCells(
    db: Db = createServerSupabase(),
): Promise<number> {
    if (process.env.ASYNC_TABULAR_EXTRACTION !== "true") return 0;

    const { data: cells, error } = await db
        .from("tabular_cells")
        .select("id, review_id, row_id, column_index, generation_id")
        .eq("status", "generating")
        .limit(MAX_GENERATING_CELLS_PER_SWEEP);
    if (error) {
        console.error("[stale-sweep] cells query failed", error);
        return 0;
    }

    const useRedis = redisEnabled();
    const jobLive = (jobId: string) =>
        useRedis
            ? getExtractionQueue()
                  .getJob(jobId)
                  .then((j) => !!j)
            : liveDbJobExists(db, jobId);
    // One liveness lookup per (review, row) — full-row jobs cover every cell
    // of their row; single-cell jobs are checked individually.
    const rowJobLive = new Map<string, boolean>();
    // One lease lookup per review.
    const leaseHeld = new Map<string, boolean>();
    // Generations we un-stamped a cell of, so their lease can be released.
    const touchedGenerations = new Map<string, string>();
    let flipped = 0;
    for (const cell of (cells ?? []) as {
        id: string;
        review_id: string;
        row_id: string;
        column_index: number;
        generation_id?: string | null;
    }[]) {
        if (!leaseHeld.has(cell.review_id))
            leaseHeld.set(
                cell.review_id,
                await hasActiveGenerationLease(db, cell.review_id),
            );
        if (leaseHeld.get(cell.review_id)) continue;

        const rowKey = `${cell.review_id}:${cell.row_id}`;
        if (!rowJobLive.has(rowKey)) {
            rowJobLive.set(
                rowKey,
                await jobLive(extractionJobId(cell.review_id, cell.row_id)),
            );
        }
        if (rowJobLive.get(rowKey)) continue;
        if (
            await jobLive(
                extractionJobId(
                    cell.review_id,
                    cell.row_id,
                    cell.column_index,
                ),
            )
        )
            continue;

        // The one guarded terminal writer: clears the stamp, and for a stamped
        // cell only matches while it still carries the stamp we read.
        await finalizeCell(db, {
            reviewId: cell.review_id,
            rowId: cell.row_id,
            columnIndex: cell.column_index,
            status: "error",
            generationId: cell.generation_id ?? undefined,
        });
        if (cell.generation_id)
            touchedGenerations.set(cell.generation_id, cell.review_id);
        flipped += 1;
        console.warn("[stale-sweep] orphaned generating cell flipped to error", {
            reviewId: cell.review_id,
            rowId: cell.row_id,
            columnIndex: cell.column_index,
        });
    }

    // Finishing work for a dead generation includes releasing its lease, once
    // no cell carries its id any more.
    for (const [generationId, reviewId] of touchedGenerations)
        await finishGenerationIfIdle(
            db,
            reviewId,
            generationId,
            console,
            "[stale-sweep]",
        );

    return flipped;
}

/** Run both sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createServerSupabase(),
): Promise<{ documents: number; cells: number }> {
    const documents = await sweepStaleProcessingDocuments(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "documents" });
        return 0;
    });
    const cells = await sweepStaleGeneratingCells(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "cells" });
        return 0;
    });
    return { documents, cells };
}
