import { isNotConnectionError } from "bullmq";
import type { EventEmitter } from "node:events";
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
 *   counted into a console.warn, reset after the failing connections each
 *   complete their Redis ready check (an INFO command, not a TCP connect).
 * - Anything else a Worker emits: its run loop, the stalled-jobs checker,
 *   scheduling, a lost lock. Those can be real defects, so they are reported
 *   at error level, stage=worker, through their own gate that reports a class
 *   again once its window has passed. A recurring defect therefore keeps
 *   reaching Sentry (once per window) instead of once per process.
 *
 * The outage warning alone does not page anyone: the org's high-priority
 * alert matches level:error, and a self-hosted install whose Redis stays down
 * has stalled uploads. So an outage that is still failing
 * OUTAGE_ESCALATION_MS after its first error without proven recovery files
 * ONE error-level event, queue.redis_outage_persisting, and nothing more
 * until the connection recovers.
 */

/** Spacing of re-reports of the same non-connection class. */
export const WORKER_ERROR_REPORT_WINDOW_MS = 15 * 60_000;
/** How long an outage keeps failing before it is reported at error level. */
export const OUTAGE_ESCALATION_MS = 15 * 60_000;

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EPIPE"]);

/** True for an error that means "Redis is unreachable", not a defect. */
export function isQueueConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
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

/** Reuse the poll gate's per-class reporting window, without retry delays. */
export function createWorkerErrorGate(options: {
    windowMs?: number;
    now?: () => number;
    log?: Pick<Console, "warn" | "log">;
} = {}) {
    const windowMs = options.windowMs ?? WORKER_ERROR_REPORT_WINDOW_MS;
    return createPollFailureGate({
        label: "[queue] worker",
        baseDelayMs: 0,
        maxDelayMs: 0,
        classify: queueErrorClass,
        repeatReportIntervalMs: windowMs,
        repeatWhilePersistingMs: windowMs,
        now: options.now,
        log: options.log,
    });
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

// Track the connections that actually failed. A healthy producer or shared
// connection must not reset a worker's independent blocking-connection outage.
const failingConnections = new Map<object, number>();
let outageEscalated = false;

// BullMQ closes a stale Queue when its producer connection is replaced.
// Retired connections cannot recover and must not poison later incidents.
function forgetClosedConnections(): void {
    for (const connection of failingConnections.keys()) {
        const status = (connection as { status?: string }).status;
        if (status === "closed" || status === "end") failingConnections.delete(connection);
    }
}

/** Called only after this connection has successfully completed a Redis command. */
export function queueConnectionRecovered(connection: object): void {
    failingConnections.delete(connection);
    forgetClosedConnections();
    if (failingConnections.size) return;
    outageEscalated = false;
    outageGate.success();
}

/** Escalate once while at least one failed connection has not recovered. */
function outagePersisting(connection: object, at: number): number | null {
    forgetClosedConnections();
    if (!failingConnections.size) outageEscalated = false;
    if (!failingConnections.has(connection)) failingConnections.set(connection, at);
    const since = Math.min(...failingConnections.values());
    if (outageEscalated || at - since < OUTAGE_ESCALATION_MS) return null;
    outageEscalated = true;
    return Math.floor((at - since) / 60_000);
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
type ErrorEmitter = Pick<EventEmitter, "on">;
type ConnectionEmitter = Pick<EventEmitter, "on" | "prependListener">;
type QueueEmitter = ErrorEmitter & {
    getBackend?: () => {
        connection: ConnectionEmitter;
        blockingConnection?: ConnectionEmitter;
    };
};
const watchedConnections = new WeakSet<object>();

export function watchQueueErrors(emitter: QueueEmitter, source: ErrorSource, queue?: string): void {
    const backend = emitter.getBackend?.();
    for (const connection of [backend?.connection, backend?.blockingConnection]) {
        if (!connection || watchedConnections.has(connection)) continue;
        watchedConnections.add(connection);
        // BullMQ forwards these errors to its Queue/Worker. Observe the actual
        // connection first so forwarding deduplication retains its identity.
        attachErrorListener(connection, source, queue, true);
        connection.on("ready", () => queueConnectionRecovered(connection));
    }
    attachErrorListener(emitter, source, queue);
    if (source === "worker") {
        // Run-loop errors may originate above the connection emitter. A job
        // claimed or an empty blocking read proves that loop is working again.
        emitter.on("active", () => queueConnectionRecovered(emitter));
        emitter.on("drained", () => queueConnectionRecovered(emitter));
    }
    if (source === "connection") {
        emitter.on("ready", () => queueConnectionRecovered(emitter));
    }
}

function attachErrorListener(
    emitter: ErrorEmitter & Partial<Pick<EventEmitter, "prependListener">>,
    source: ErrorSource,
    queue?: string,
    prepend = false,
): void {
    const tags = (stage: string): Record<string, string> =>
        queue ? { component: "queue", stage, queue } : { component: "queue", stage };
    const where = queue ? ` (${queue})` : "";
    const onError = (error: Error) => {
        if (error && typeof error === "object") {
            if (seen.has(error)) return;
            seen.add(error);
        }
        if (isQueueConnectionError(error)) {
            const minutes = outagePersisting(emitter, Date.now());
            if (minutes !== null) {
                reportError(
                    new AppError(
                        "queue.redis_outage_persisting",
                        `Redis queue connection still failing after ${minutes} minutes`,
                        { cause: error },
                    ),
                    { level: "error", tags: { ...tags("connection"), outage_minutes: minutes } },
                );
                console.warn(`[queue] redis still unreachable after ${minutes} minutes`, pollFailureClass(error));
            }
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
        console.warn(`[queue] ${source} error${where}`, queueErrorClass(error));
    };
    if (prepend && emitter.prependListener) emitter.prependListener("error", onError);
    else emitter.on("error", onError);
}
