// extraction transport — implementation behind the module facade.
import { Worker, UnrecoverableError, type Job } from "bullmq";
import { ExtractionLimitError } from "../lib/extraction/limits";
import { runIsolated } from "../lib/dbq/jobScope";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError } from "../lib/observability/sentry";
import { EXTRACTION_QUEUE, type ExtractionJobData } from "../lib/queue/extractionQueue";
import { extractionJobOperation, runExtractionJob, markExtractionFailed } from "../modules/tabular/tabular.service";

/** Terminal resource refusals and exhausted retries both need cell cleanup. */
export function isPermanentFailure(job: Job<ExtractionJobData>, error?: Error): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return error instanceof UnrecoverableError || job.attemptsMade >= maxAttempts;
}

let worker: Worker<ExtractionJobData> | null = null;

export function createExtractionWorker(): Worker<ExtractionJobData> {
    if (worker) return worker;
    worker = new Worker<ExtractionJobData>(
        EXTRACTION_QUEUE,
        async (job: Job<ExtractionJobData>) => {
            // Own isolation scope per job (concurrency is 3); the job body
            // names its operation (tabular.cell or tabular.row).
            await runIsolated(async () => {
                try {
                    await runExtractionJob(job.data);
                } catch (error) {
                    if (error instanceof ExtractionLimitError) throw new UnrecoverableError("document_too_large");
                    throw error;
                }
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
        const permanent = !!job && isPermanentFailure(job, err);
        // The 'failed' event fires outside the processor's isolation scope,
        // so the operation is named here rather than inherited.
        reportError(err, {
            level: permanent ? "error" : "warning",
            tags: {
                component: "extraction-worker",
                operation: extractionJobOperation(job?.data ?? {}),
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
                    operation: extractionJobOperation(job.data),
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
