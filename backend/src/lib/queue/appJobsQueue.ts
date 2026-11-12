import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { getRedisProducerConnection, withRedisTimeout, watchQueueErrors } from "./connection";

/**
 * BullMQ *delivery* queue for the DB-backed registry jobs (audit, deletion,
 * storage cleanup, exports, …) — the fast half of the transactional-outbox
 * pattern.
 *
 * The db_jobs row is the durable record and the ONLY authority on execution:
 * this queue merely carries the row's id to a worker immediately instead of
 * waiting for the poller. The worker claims the row through Postgres
 * (claim_db_job), so a lost delivery is recovered by the poll backstop and a
 * duplicated delivery claims zero rows. Consequently these jobs need no
 * BullMQ retries (attempts: 1) and no history (removed on completion either
 * way).
 */
export const APP_JOBS_QUEUE = "app-jobs";

export interface AppJobDelivery {
    /** db_jobs.id to claim and run. */
    dbJobId: string;
}

let queue: Queue<AppJobDelivery> | null = null;
let queueConnection: IORedis | null = null;

export function getAppJobsQueue(): Queue<AppJobDelivery> {
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
        queue = new Queue<AppJobDelivery>(APP_JOBS_QUEUE, { connection });
        watchQueueErrors(queue, "producer", APP_JOBS_QUEUE);
        queueConnection = connection;
    }
    return queue;
}

/**
 * Deliver one db_jobs row id, optionally delayed (used to redeliver a retry
 * at its backoff time). The jobId carries the attempt so a retry's delivery
 * never dedupes against a still-draining earlier delivery of the same row.
 */
export function enqueueAppJobDelivery(
    dbJobId: string,
    opts?: { delayMs?: number; attempt?: number },
) {
    // Deadline-bounded: this runs on request threads (chat audit fan-out,
    // account deletion, export scheduling). The db_jobs row is already
    // committed, so a timeout here costs latency on the job, never the job.
    return withRedisTimeout("app-jobs delivery", () =>
        getAppJobsQueue().add(
            "deliver",
            { dbJobId },
            {
                // Underscores, not ':' — see conversionJobId's note on BullMQ ids.
                jobId: `dbjob_${dbJobId}_${opts?.attempt ?? 0}`,
                attempts: 1,
                ...(opts?.delayMs && opts.delayMs > 0
                    ? { delay: opts.delayMs }
                    : {}),
                removeOnComplete: true,
                removeOnFail: true,
            },
        ),
    );
}

export async function closeAppJobsQueue(): Promise<void> {
    if (queue) {
        await queue.close();
        queue = null;
    }
}
