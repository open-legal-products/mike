import { afterAll, expect, it, vi } from "vitest";
import { Worker } from "bullmq";

// The production path for MIK-91. Once a BullMQ Worker is built on the shared
// consumer connection, BullMQ attaches its own 'error' listener to that client
// and forwards every error to Worker.emit('error') (RedisConnection
// .handleClientError -> QueueBase). So during an outage the same reconnect
// error reaches the connection's listener AND each Worker's, and the Worker's
// blocking client adds failures of its own. All of that is one outage: one
// warning. A Worker's own errors (a lost lock, a run-loop failure) are not an
// outage: they are reported at error level, stage=worker, once per class.
const mocks = vi.hoisted(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6398";
    return { reportError: vi.fn() };
});
vi.mock("../../observability/sentry", async (load) => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));

import { closeRedisConnection, getRedisConnection, watchQueueErrors } from "../connection";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";

let worker: Worker | null = null;

afterAll(async () => {
    const closing = worker?.close(true).catch(() => {});
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    await closeRedisConnection().catch(() => {});
    vi.restoreAllMocks();
});

const reportsOfKind = (kind: string) =>
    mocks.reportError.mock.calls.filter(
        ([error]) => diagnosticErrorTags(error).error_kind === kind,
    );

it("files one outage warning across the connection and a real Worker, and Worker defects separately at error level", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const connection = getRedisConnection();
    worker = new Worker("mik91-worker-errors", async () => undefined, { connection });
    watchQueueErrors(worker, "worker");
    const onWorker: Error[] = [];
    worker.on("error", (error) => onWorker.push(error));
    const onConnection: Error[] = [];
    connection.on("error", (error) => onConnection.push(error));

    // Wait for a connection error that BullMQ forwarded to the Worker (same
    // object on both emitters) plus a further failed attempt.
    await vi.waitFor(
        () => {
            expect(onWorker.some((error) => onConnection.includes(error))).toBe(true);
            expect(onWorker.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 8_000 },
    );

    const outage = reportsOfKind("queue.connection_lost");
    expect(outage).toHaveLength(1);
    expect(diagnosticErrorTags(outage[0][0]).failure_code).toBe("ECONNREFUSED");
    expect(outage[0][1]).toEqual({
        level: "warning",
        tags: { component: "queue", stage: "connection" },
    });
    expect(reportsOfKind("queue.worker_error")).toHaveLength(0);

    // BullMQ's own messages, as lock-manager.js and finished-errors.js build
    // them: one lost lease touches several jobs, which is still one class.
    worker.emit("error", new Error("could not renew lock for job 101"));
    worker.emit("error", new Error("could not renew lock for job 102"));
    worker.emit("error", new Error("Missing lock for job 103. moveToFinished"));

    const defects = reportsOfKind("queue.worker_error");
    expect(defects).toHaveLength(2);
    for (const [, context] of defects) {
        expect(context).toEqual({
            level: "error",
            tags: { component: "queue", stage: "worker" },
        });
    }
    // The outage report is not affected by the Worker defects.
    expect(reportsOfKind("queue.connection_lost")).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
});
