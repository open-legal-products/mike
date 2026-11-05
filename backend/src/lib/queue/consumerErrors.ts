import { isNotConnectionError } from "bullmq";
import { AppError } from "../appError";
import { reportError } from "../observability/sentry";
import {
    createPollFailureGate,
    pollFailureClass,
} from "../observability/pollFailureGate";

/**
 * Error listeners for BullMQ: the shared consumer connection, each Worker,
 * and each producer Queue. Without one, ioredis prints "[ioredis] Unhandled
 * error event" and BullMQ's QueueBase.emit falls back to console.error, and the Sentry
 * console bridge files each line as an untyped "Failure in application" under
 * a node_modules culprit (MIK-91).
 *
 * Two kinds of error reach these listeners, and they need opposite handling:
 *
 * - A lost connection (an errno such as ECONNREFUSED, or BullMQ's
 *   "Connection is closed."). That is the install's Redis being down, not a
 *   defect, and it repeats on every reconnect attempt of every client. It
 *   goes through ONE outage gate: one warning per outage and class, repeats
 *   counted into a console.warn, reset when the shared connection is ready.
 * - Anything else a Worker emits: its run loop, the stalled-jobs checker,
 *   scheduling, a lost lock. Those can be real defects, so they are reported
 *   at error level, stage=worker, through their own gate that reports a class
 *   again once its window has passed. A recurring defect therefore keeps
 *   reaching Sentry (once per window) instead of once per process.
 */

/** Spacing of re-reports of the same non-connection class. */
export const WORKER_ERROR_REPORT_WINDOW_MS = 15 * 60_000;
/** Spacing of the console line that counts suppressed repeats. */
const SUMMARY_INTERVAL_MS = 60_000;

const ERRNO = /^E[A-Z0-9_]{2,30}$/;

/** True for an error that means "Redis is unreachable", not a defect. */
export function isQueueConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && ERRNO.test(code)) return true;
    try {
        return !isNotConnectionError(error);
    } catch {
        return false;
    }
}

// BullMQ puts the job id in its lock and state messages ("could not renew
// lock for job 42", "Missing lock for job 42. moveToFinished"). Classing by
// the raw message would make every affected job a new class, so one lost
// Redis lease would file one report per job.
const JOB_ID = /(\bjob\s+)[^\s.,;:]+/gi;

/** pollFailureClass, with BullMQ's job id taken out of the message. */
export function queueErrorClass(error: unknown): string {
    if (!(error instanceof Error)) return pollFailureClass(error);
    const errno = (error as { code?: unknown }).code;
    return pollFailureClass({
        name: error.name,
        message: error.message.replace(JOB_ID, "$1<id>"),
        code: errno,
        cause: error.cause,
    });
}

/**
 * Report-once-per-window gate for non-connection errors. Unlike the outage
 * gate it has no "still failing" state to reset: each class is reported when
 * it was not reported within the window, whatever else happened in between.
 */
export function createWorkerErrorGate(options: {
    windowMs?: number;
    now?: () => number;
    log?: Pick<Console, "warn">;
} = {}): { failure(error: unknown): { report: boolean; failureClass: string } } {
    const windowMs = options.windowMs ?? WORKER_ERROR_REPORT_WINDOW_MS;
    const now = options.now ?? Date.now;
    const log = options.log ?? console;
    const classes = new Map<
        string,
        { reportedAt: number; suppressed: number; lineAt: number }
    >();
    return {
        failure(error) {
            const failureClass = queueErrorClass(error);
            const at = now();
            for (const [key, entry] of classes) {
                if (at - entry.reportedAt >= windowMs) classes.delete(key);
            }
            const entry = classes.get(failureClass);
            if (!entry) {
                classes.set(failureClass, { reportedAt: at, suppressed: 0, lineAt: at });
                return { report: true, failureClass };
            }
            entry.suppressed += 1;
            if (at - entry.lineAt >= SUMMARY_INTERVAL_MS) {
                log.warn(
                    `[queue] worker error repeating (${failureClass}): ${entry.suppressed} not re-reported; ` +
                        `next report after ${Math.round((entry.reportedAt + windowMs - at) / 1000)}s`,
                );
                entry.lineAt = at;
                entry.suppressed = 0;
            }
            return { report: false, failureClass };
        },
    };
}

/**
 * The outage gate shared by every queue-side emitter, consumer and producer.
 * Delays are unused: ioredis owns the reconnect schedule.
 */
const outageGate = createPollFailureGate({
    label: "[queue] redis",
    baseDelayMs: 0,
    maxDelayMs: 0,
});
const workerErrorGate = createWorkerErrorGate();

// BullMQ forwards the shared connection's errors to every Worker built on it
// (RedisConnection.handleClientError → QueueBase.emit), so one failed
// reconnect arrives once on the connection and once per Worker as the SAME
// Error object. Count it once, so the outage gate's "recovered after N
// consecutive failure(s)" counts failed attempts, not listeners.
const seen = new WeakSet<object>();

/** Call when a shared Redis connection (consumer or producer) is ready again. */
export function queueConnectionRecovered(): void {
    outageGate.success();
}

type ErrorSource = "connection" | "worker" | "producer";

const DEFECT_KIND: Record<ErrorSource, string> = {
    connection: "queue.redis_error",
    worker: "queue.worker_error",
    producer: "queue.producer_error",
};

/**
 * Give a queue-side emitter an 'error' listener. `source` is "connection"
 * for the shared consumer ioredis client, "worker" for a BullMQ Worker and
 * "producer" for a BullMQ Queue (pass its name as `queue`).
 *
 * A producer Queue needs one as much as a Worker does: BullMQ wraps the
 * producer connection and forwards its reconnect errors to every Queue built
 * on it, and a Queue with no listener prints each one through
 * QueueBase.emit's console.error fallback. The stale-cell sweep's job lookup
 * builds the extraction Queue, so during an outage its raw ECONNREFUSED
 * blocks reached the console bridge as "Failure in maintenance.cells /
 * application / ECONNREFUSED" (MIKE-BACKEND-42). Producer and consumer share
 * the one outage gate: a Redis outage is one warning whichever side saw it.
 */
export function watchQueueErrors(
    emitter: { on(event: "error", listener: (error: Error) => void): unknown },
    source: ErrorSource,
    queue?: string,
): void {
    const tags = (stage: string): Record<string, string> =>
        queue ? { component: "queue", stage, queue } : { component: "queue", stage };
    const where = queue ? ` (${queue})` : "";
    emitter.on("error", (error) => {
        if (error && typeof error === "object") {
            if (seen.has(error)) return;
            seen.add(error);
        }
        if (isQueueConnectionError(error)) {
            if (!outageGate.failure(error).report) return;
            reportError(
                new AppError("queue.connection_lost", "Redis queue connection lost", {
                    cause: error,
                }),
                { level: "warning", tags: tags("connection") },
            );
            console.warn(
                `[queue] redis ${source === "producer" ? "producer" : "consumer"} error${where}`,
                pollFailureClass(error),
            );
            return;
        }
        const verdict = workerErrorGate.failure(error);
        if (!verdict.report) return;
        reportError(new AppError(DEFECT_KIND[source], "Redis queue error", { cause: error }), {
            level: "error",
            tags: tags(source),
        });
        console.warn(`[queue] ${source} error${where}`, verdict.failureClass);
    });
}
