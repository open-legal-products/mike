// conversion transport — implementation behind the module facade.
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import { CONVERSION_QUEUE, type ConversionJobData } from "../lib/queue/conversionQueue";
import { createServerSupabase } from "../lib/supabase";
import { runConversionJob, setDocumentTerminalStatus } from "../modules/documents/documents.service";

/** True once a job has exhausted its retries (BullMQ 'failed', no attempts left). */
export function isPermanentFailure(job: Job<ConversionJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
}

let worker: Worker<ConversionJobData> | null = null;

export function createConversionWorker(): Worker<ConversionJobData> {
    if (worker) return worker;
    worker = new Worker<ConversionJobData>(
        CONVERSION_QUEUE,
        async (job: Job<ConversionJobData>) => {
            await runConversionJob(job.data);
        },
        {
            connection: getRedisConnection(),
            concurrency: 2,
            // Recover jobs orphaned by a worker crash mid-run: re-queue a job
            // whose lock hasn't been renewed within stalledInterval, up to
            // maxStalledCount times before it's failed for good.
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("stalled", (jobId) => {
        console.warn(
            "[conversion-worker] job stalled; will be re-queued",
            { jobId },
        );
    });
    worker.on("failed", async (job, err) => {
        if (!job) {
            console.error("[conversion-worker] job failed (no job)", { err });
            return;
        }
        if (!isPermanentFailure(job)) {
            console.error(
                "[conversion-worker] job failed (will retry, attempts remain)",
                { jobId: job.id, err },
            );
            return;
        }
        // Retries exhausted. For the initial-upload flow the document is stuck
        // "processing" with no path forward — surface it as a terminal
        // "error". Version flows (finalizeDocumentStatus: false) belong to an
        // already-healthy document: the version simply keeps no rendition.
        if (job.data.finalizeDocumentStatus === false) {
            console.error(
                "[conversion-worker] version rendition permanently failed; document left untouched",
                { jobId: job.id, versionId: job.data.versionId, err },
            );
            return;
        }
        console.error(
            "[conversion-worker] job permanently failed; marking document error",
            { jobId: job.id, documentId: job.data.documentId, err },
        );
        try {
            await setDocumentTerminalStatus(
                createServerSupabase(),
                job.data.documentId,
                "error",
            );
        } catch (updateErr) {
            console.error(
                "[conversion-worker] failed to mark document error",
                { jobId: job.id, documentId: job.data.documentId, updateErr },
            );
        }
    });
    return worker;
}

export async function stopConversionWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
