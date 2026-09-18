// extraction transport — implementation behind the module facade.
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError } from "../lib/observability/sentry";
import { EXTRACTION_QUEUE, type ExtractionJobData } from "../lib/queue/extractionQueue";
import { runExtractionJob, markExtractionFailed } from "../modules/tabular/tabular.service";

/** True once a job has exhausted its retries (BullMQ 'failed', no attempts left). */
export function isPermanentFailure(job: Job<ExtractionJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
}

let worker: Worker<ExtractionJobData> | null = null;

export function createExtractionWorker(): Worker<ExtractionJobData> {
    if (worker) return worker;
    worker = new Worker<ExtractionJobData>(
        EXTRACTION_QUEUE,
        async (job: Job<ExtractionJobData>) => {
            await runExtractionJob(job.data);
        },
        {
            connection: getRedisConnection(),
            concurrency: 3,
            // Recover jobs orphaned by a worker crash mid-run: re-queue a job
            // whose lock hasn't been renewed within stalledInterval, up to
            // maxStalledCount times before it's failed for good.
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("stalled", (jobId) => {
        console.warn(
            "[extraction-worker] job stalled; will be re-queued",
            { jobId },
        );
    });
    worker.on("failed", async (job, err) => {
        const permanent = !!job && isPermanentFailure(job);
        reportError(err, {
            level: permanent ? "error" : "warning",
            tags: {
                component: "extraction-worker",
                terminal: permanent,
                attempt: job?.attemptsMade,
            },
            extra: {
                job_id: job?.id,
                review_id: job?.data.reviewId,
                row_id: job?.data.rowId,
            },
        });
        if (!job) {
            console.error("[extraction-worker] job failed (no job)", { err });
            return;
        }
        if (!permanent) {
            console.error(
                "[extraction-worker] job failed (will retry, attempts remain)",
                { jobId: job.id, err },
            );
            return;
        }
        console.error(
            "[extraction-worker] job permanently failed; marking cells error",
            {
                jobId: job.id,
                reviewId: job.data.reviewId,
                rowId: job.data.rowId,
                err,
            },
        );
        try {
            await markExtractionFailed(job.data);
        } catch (updateErr) {
            console.error(
                "[extraction-worker] failed to mark cells error",
                { jobId: job.id, updateErr },
            );
        }
    });
    return worker;
}

export async function stopExtractionWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
