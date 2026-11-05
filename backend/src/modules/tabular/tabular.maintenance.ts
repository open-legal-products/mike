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
import { finishGenerationIfIdle } from "./tabular.shared";
import { redisEnabled } from "../../lib/dbq/driver";
import { liveDbJobDedupeKeys } from "../../lib/dbq/enqueue";
import { chunkArray } from "../../lib/arrays";
import { ID_FILTER_BATCH_SIZE, mutateInBatches, selectInBatches } from "../../lib/batchedQuery";
import { mapWithConcurrency } from "../../lib/concurrency";
import { AppError } from "../../lib/appError";
import { reportError } from "../../lib/observability/sentry";

/**
 * A sweep query the database refused. supabase-js resolves these as plain
 * objects, which the console bridge files with no stack and no code; wrapped,
 * the SQLSTATE rides along as failure_code under one kind. Returns the
 * reported object so the caller logs that and the bridge files nothing twice.
 */
function reportSweepQueryFailure(message: string, cause: unknown): AppError {
    const failure = new AppError("db.query_failed", message, { cause });
    reportError(failure, { tags: { component: "stale-sweep" } });
    return failure;
}

// Cap one sweep's working set: the query is unbounded otherwise, and each cell
// costs a Redis lookup. Anything left over is picked up by the next sweep.
const MAX_GENERATING_CELLS_PER_SWEEP = 500;

/**
 * Which of these reviews still have a live holder for their generation?
 *
 * The lease is the authoritative liveness signal for tabular work: a running
 * request or worker renews it well inside its window, so an unexpired lease
 * means someone owns the review's "generating" cells and will write their
 * terminal state. Fails SAFE — a lookup error reports every review as
 * "owned" rather than let the sweep stomp a live run.
 */
async function reviewLeasesHeld(db: Db, reviewIds: string[]): Promise<Set<string>> {
    type LeaseRow = {
        id: string;
        active_generation_id?: string | null;
        generation_lease_expires_at?: string | null;
    };
    let reviews: LeaseRow[];
    try {
        reviews = await selectInBatches<LeaseRow>("review lease lookup", reviewIds, (batch) =>
            db
                .from("tabular_reviews")
                .select("id, active_generation_id, generation_lease_expires_at")
                .in("id", batch),
        );
    } catch (error) {
        console.error("[stale-sweep] review lease lookup failed", {
            reviews: reviewIds.length,
            error: reportSweepQueryFailure("Stale-sweep review lease lookup failed", error),
        });
        return new Set(reviewIds);
    }
    const held = new Set<string>();
    for (const review of reviews) {
        if (!review.active_generation_id || !review.generation_lease_expires_at) continue;
        const expiresAt = Date.parse(String(review.generation_lease_expires_at));
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) held.add(review.id);
    }
    return held;
}

/**
 * Which of these extraction job ids still exist (waiting/active/delayed):
 * one DB query per 50 ids on the Postgres queue, a few concurrent
 * lookups on BullMQ. Fails SAFE — an unanswerable lookup counts as live.
 */
async function liveExtractionJobs(db: Db, jobIds: string[]): Promise<Set<string>> {
    const live = new Set<string>();
    try {
        if (redisEnabled()) {
            const found = await mapWithConcurrency(jobIds, 8, async (jobId) =>
                (await withRedisTimeout("extraction job lookup", () =>
                    getExtractionQueue().getJob(jobId),
                ))
                    ? jobId
                    : null,
            );
            for (const jobId of found) if (jobId) live.add(jobId);
        } else {
            for (const batch of chunkArray(jobIds, ID_FILTER_BATCH_SIZE))
                for (const key of await liveDbJobDedupeKeys(db, batch)) live.add(key);
        }
    } catch (error) {
        console.error("[stale-sweep] extraction job lookup failed", {
            jobs: jobIds.length,
            error: reportSweepQueryFailure("Stale-sweep job lookup failed", error),
        });
        return new Set(jobIds);
    }
    return live;
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
        console.error(
            "[stale-sweep] cells query failed",
            reportSweepQueryFailure("Stale-sweep cells query failed", error),
        );
        return 0;
    }

    type GeneratingCell = {
        id: string;
        review_id: string;
        row_id: string;
        column_index: number;
        generation_id?: string | null;
    };
    const rows = (cells ?? []) as GeneratingCell[];

    // Every question is asked for the whole page at once: the leases of the
    // page's reviews, then the liveness of every candidate job (each row's
    // full-row job and each cell's single-cell job), then one guarded write
    // per generation. Per cell, the old loop paid up to three sequential
    // lookups plus its own write.
    const leaseHeld = await reviewLeasesHeld(db, rows.map((cell) => cell.review_id));
    const candidates = rows.filter((cell) => !leaseHeld.has(cell.review_id));
    const rowJob = (cell: GeneratingCell) => extractionJobId(cell.review_id, cell.row_id);
    const cellJob = (cell: GeneratingCell) =>
        extractionJobId(cell.review_id, cell.row_id, cell.column_index);
    const live = await liveExtractionJobs(db, [
        ...new Set(candidates.flatMap((cell) => [rowJob(cell), cellJob(cell)])),
    ]);
    const orphaned = candidates.filter(
        (cell) => !live.has(rowJob(cell)) && !live.has(cellJob(cell)),
    );

    // The guarded terminal write, batched: clears the stamp, and for a
    // stamped cell only matches while it still carries the stamp we read.
    const byGeneration = new Map<string | null, GeneratingCell[]>();
    for (const cell of orphaned) {
        const key = cell.generation_id ?? null;
        byGeneration.set(key, [...(byGeneration.get(key) ?? []), cell]);
    }
    // Generations we un-stamped a cell of, so their lease can be released.
    const touchedGenerations = new Map<string, string>();
    let flipped = 0;
    for (const [generationId, group] of byGeneration) {
        try {
            await mutateInBatches("stale cell flip", group.map((cell) => cell.id), (batch) => {
                const query = db
                    .from("tabular_cells")
                    .update({ status: "error", content: null, generation_id: null })
                    .in("id", batch);
                return generationId ? query.eq("generation_id", generationId) : query;
            });
        } catch (flipError) {
            console.error("[stale-sweep] cell flip failed", {
                cells: group.length,
                error: reportSweepQueryFailure("Stale-sweep cell flip failed", flipError),
            });
            continue;
        }
        for (const cell of group) {
            if (generationId) touchedGenerations.set(generationId, cell.review_id);
            flipped += 1;
            console.warn("[stale-sweep] orphaned generating cell flipped to error", {
                reviewId: cell.review_id,
                rowId: cell.row_id,
                columnIndex: cell.column_index,
            });
        }
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
