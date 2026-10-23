// extraction transport — implementation behind the module facade.
import { Worker, type Job } from "bullmq";
import { runIsolated } from "../lib/dbq/jobScope";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError, setOperation } from "../lib/observability/sentry";
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
            // Own isolation scope per job (concurrency is 3); the tabular
            // module's job body does not name its operation, so name it here.
            await runIsolated(async () => {
                setOperation("documents.extract");
                await runExtractionJob(job.data);
            });
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
        // The 'failed' event fires outside the processor's isolation scope,
        // so the operation is named here rather than inherited.
        reportError(err, {
            level: permanent ? "error" : "warning",
            tags: {
                component: "extraction-worker",
                operation: "documents.extract",
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
            // Cells stay "generating" forever if this write is lost: reported
            // with the terminal stage, logged as the same object.
            reportError(updateErr, {
                tags: {
                    component: "extraction-worker",
                    operation: "documents.extract",
                    stage: "job.terminal",
                },
                extra: { job_id: job.id, review_id: job.data.reviewId },
            });
            console.error(
                "[extraction-worker] failed to mark cells error",
                { jobId: job.id, error: updateErr },
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
