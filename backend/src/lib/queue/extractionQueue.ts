import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { getRedisProducerConnection, withRedisTimeout } from "./connection";
import { redisEnabled } from "../dbq/driver";
import { enqueueDbJob } from "../dbq/enqueue";
import { createServerSupabase } from "../supabase";
import { mapWithConcurrency } from "../concurrency";

/** Jobs that do exist are cancelled a few at a time, not one by one. */
const CANCEL_CONCURRENCY = 8;

/**
 * BullMQ queue that runs tabular-review cell extraction off the request thread.
 *
 * One job == one (review, row) pair — a row is one document or a folder of
 * source documents extracted together. The job re-derives everything it needs
 * from the database at run time (review columns, current cell state, the row's
 * source documents, the owner's model + API keys), so the job payload stays tiny
 * and — importantly — carries NO secrets into Redis. This also makes the job
 * idempotent and retry-safe: on a retry it re-reads cell state and only
 * processes columns that are not already `done`.
 */
export const EXTRACTION_QUEUE = "tabular-extraction";

export interface ExtractionJobData {
    /** tabular_reviews.id the cells belong to. */
    reviewId: string;
    /** Owner — used to resolve the model + API keys the extraction runs under. */
    userId: string;
    /** tabular_review_rows.id whose columns this job fills. */
    rowId: string;
    /**
     * The generation this job belongs to. The enqueuing request claimed the
     * review's generation lease under this id and stamped the targeted cells
     * with it; the worker renews the lease while it runs, guards its cell
     * writes with it, and releases the lease when no stamped cell is left.
     * Absent only for a job enqueued outside a leased run.
     */
    generationId?: string;
    /**
     * When set, the job targets ONE cell (regenerate-cell) instead of every
     * outstanding column of the row. Single-cell jobs get their own jobId
     * suffix so they never dedupe against a full-row job for the same row.
     */
    columnIndex?: number;
    /**
     * Set by clear-cells on a job it could not remove (already active).
     * Persisted via job.updateData(), so the worker's NEXT attempt — which
     * re-fetches job data from Redis — sees it and returns without re-claiming
     * the cleared cells. (An in-flight attempt is unaffected: clear-cells drops
     * the cells' generation stamp, so that attempt's terminal writes — guarded
     * by `.eq("generation_id", generationId)` — match no rows.)
     */
    canceled?: boolean;
}

let queue: Queue<ExtractionJobData> | null = null;
let queueConnection: IORedis | null = null;

export function getExtractionQueue(): Queue<ExtractionJobData> {
    // The producer connection is replaced when it wedges (see connection.ts);
    // a Queue still holding the dead client can never deliver again, so
    // compare identity on every call and rebuild on a fresh connection.
    const connection = getRedisProducerConnection();
    if (queue && queueConnection !== connection) {
        const stale = queue;
        queue = null;
        void Promise.resolve()
            .then(() => stale.close())
            .catch(() => {});
    }
    if (!queue) {
        queue = new Queue<ExtractionJobData>(EXTRACTION_QUEUE, { connection });
        queueConnection = connection;
    }
    return queue;
}

/**
 * Deterministic BullMQ jobId for one (review, row[, column]) extraction
 * (doubles as the DB-queue dedupe key). Underscore separator, NOT ':' —
 * BullMQ reserves ':' as its Redis key separator and rejects most
 * colon-containing custom ids (only a legacy 3-segment form is tolerated,
 * so `extract:a:b` would work while `extract:a:b:0` throws — a trap).
 */
export function extractionJobId(
    reviewId: string,
    rowId: string,
    columnIndex?: number,
): string {
    return columnIndex == null
        ? `extract_${reviewId}_${rowId}`
        : `extract_${reviewId}_${rowId}_${columnIndex}`;
}

/**
 * Enqueue extraction for one row of a review. Retries transient failures
 * (LLM/network/storage hiccups) with exponential backoff.
 *
 * The jobId is deterministic on (reviewId, rowId) so a double submit — e.g.
 * a client reconnecting and re-POSTing /generate — is deduped by BullMQ into the
 * in-flight job instead of racing a second extraction over the same row.
 * We `removeOnComplete`/`removeOnFail` immediately (not keep-N) precisely so a
 * later re-run (regenerate) can enqueue the same jobId again; durable state
 * lives in the `tabular_cells` table, not in the job record.
 */
export async function enqueueExtraction(data: ExtractionJobData) {
    // Postgres driver: same job on the DB queue — same dedupe identity and
    // retry budget, same handler body (runExtractionJob). Live progress
    // frames are skipped in this mode; the SSE views' DB-poll backstops
    // resolve every cell (they already had to, for missed pub/sub frames).
    if (!redisEnabled()) {
        return enqueueDbJob(createServerSupabase(), {
            kind: "extraction.extract",
            payload: data as unknown as Record<string, unknown>,
            dedupeKey: extractionJobId(data.reviewId, data.rowId, data.columnIndex),
            maxAttempts: 3,
        });
    }
    // Deadline-bounded — see enqueueAppJobDelivery: a Redis outage must not
    // hang the /generate request that is enqueuing this row.
    return withRedisTimeout("extraction enqueue", () =>
        getExtractionQueue().add("extract", data, {
            jobId: extractionJobId(data.reviewId, data.rowId, data.columnIndex),
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: true,
            removeOnFail: true,
        }),
    );
}

/**
 * Best-effort cancellation of extraction work for a set of rows — the queue
 * half of clear-cells. Deterministic jobIds make this a direct lookup: for
 * each row we address the full-row job and every possible single-cell
 * (regenerate) job.
 *
 * clear-cells only calls this once it HOLDS the review's generation lease, so
 * no healthy run is in play. What it reaps is the wreckage of a LAPSED one: a
 * generation whose worker died or stalled past its lease can leave orphan jobs
 * behind in Redis, and those would otherwise re-fill the row moments after the
 * user blanked it.
 *
 * - waiting/delayed jobs are REMOVED — they never (re)start, so the cleared
 *   cells stay cleared.
 * - an active (zombie) job cannot be stopped mid-run, and Job#discard() is only
 *   an in-memory flag on the worker's OWN instance — useless from this process.
 *   Instead the job's data is marked `canceled: true` via updateData(), which
 *   IS persisted: the next attempt re-fetches job data from Redis, sees the
 *   marker in runExtractionJob, and returns without re-claiming the cleared
 *   cells — dropping its generation stamp so the stale lease is released.
 *   The in-flight attempt's terminal writes are already dead: clear-cells
 *   nulls the cells' generation_id, and those writes are guarded on it.
 *
 * Every failure is swallowed per job: cancellation is an optimization on top
 * of the generation guards, never a correctness dependency.
 */
export async function removeQueuedExtractionJobs(
    reviewId: string,
    rowIds: string[],
    columnIndexes: number[],
): Promise<{ removed: number; canceled: number }> {
    // Postgres driver: one RPC deletes the pending rows and stamps a
    // persisted `canceled` marker into running ones — the exact analogue of
    // the remove + updateData split below (the RPC reports one merged count).
    if (!redisEnabled()) {
        const keys = rowIds.flatMap((rowId) => [
            extractionJobId(reviewId, rowId),
            ...columnIndexes.map((c) => extractionJobId(reviewId, rowId, c)),
        ]);
        const { data, error } = await createServerSupabase().rpc(
            "cancel_db_jobs",
            { p_dedupe_keys: keys },
        );
        if (error) throw new Error(error.message);
        return { removed: (data as number) ?? 0, canceled: 0 };
    }
    const queue = getExtractionQueue();
    const jobIds = rowIds.flatMap((rowId) => [
        extractionJobId(reviewId, rowId),
        ...columnIndexes.map((c) => extractionJobId(reviewId, rowId, c)),
    ]);
    // One pipelined EXISTS for every candidate id: most of them (every
    // per-column id of a row that was never regenerated on its own) name no
    // job at all, and asking BullMQ for each one cost a round trip apiece —
    // ~15k sequential calls to cancel a 500-row x 10-column clear.
    let live: string[];
    try {
        const pipeline = getRedisProducerConnection().pipeline();
        for (const jobId of jobIds) pipeline.exists(queue.toKey(jobId));
        const answers = (await pipeline.exec()) ?? [];
        live = jobIds.filter((_, i) => answers[i]?.[1] === 1);
    } catch {
        return { removed: 0, canceled: 0 };
    }
    let removed = 0;
    let canceled = 0;
    await mapWithConcurrency(live, CANCEL_CONCURRENCY, async (jobId) => {
        try {
            const job = await queue.getJob(jobId);
            if (!job) return;
            if ((await job.getState()) === "active") {
                await job.updateData({ ...job.data, canceled: true });
                canceled++;
            } else {
                try {
                    await job.remove();
                    removed++;
                } catch {
                    // Raced the worker: the job went active between the
                    // state check and remove(). Fall back to the marker.
                    await job.updateData({ ...job.data, canceled: true });
                    canceled++;
                }
            }
        } catch {
            // Job finished/vanished mid-race — the write guards cover it.
        }
    });
    return { removed, canceled };
}

export async function closeExtractionQueue(): Promise<void> {
    if (queue) {
        await queue.close();
        queue = null;
    }
}
