// tabularMaintenance — implementation behind the module facade.
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
import { getExtractionQueue, extractionJobId } from "../../lib/queue/extractionQueue";
import { withRedisTimeout } from "../../lib/queue/connection";
// KNOWN LAYERING INVERSION: lib/ normally must not import from modules/, but
// the cell-finalization primitives are domain logic that belongs to the
// tabular module. Import them ONLY through the module's service facade; do
// not add further lib -> modules edges (a follow-up will move this sweep's
// tabular half into the module instead).
import { finalizeCell, finishGenerationIfIdle } from "./tabular.service";
import { redisEnabled } from "../../lib/dbq/driver";
import { liveDbJobExists } from "../../lib/dbq/enqueue";

// Cap one sweep's working set: the query is unbounded otherwise, and each cell
// costs a Redis lookup. Anything left over is picked up by the next sweep.
const MAX_GENERATING_CELLS_PER_SWEEP = 500;

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
            ? withRedisTimeout("extraction job lookup", () =>
                  getExtractionQueue().getJob(jobId),
              ).then((j) => !!j)
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
