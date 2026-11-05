import { afterAll, expect, it, vi } from "vitest";

// MIKE-BACKEND-42 on the producer side. The stale-cell sweep asks the
// extraction Queue whether a cell's job still exists. During a Redis outage
// BullMQ forwards every failed reconnect of the producer connection to that
// Queue (RedisConnection.handleClientError -> QueueBase.emit); a Queue with no
// 'error' listener prints each one through console.error, and the console
// bridge filed them as "Failure in maintenance.cells / application /
// ECONNREFUSED" at error level. With a listener, the outage is the same one
// warning the consumer side files, and the sweep still leaves the cells alone.
const mocks = vi.hoisted(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6397";
    process.env.REDIS_PRODUCER_TIMEOUT_MS = "300";
    process.env.ASYNC_TABULAR_EXTRACTION = "true";
    return { reportError: vi.fn() };
});
vi.mock("../../observability/sentry", async (load) => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));
vi.mock("../../../modules/tabular/tabular.shared", () => ({
    finishGenerationIfIdle: vi.fn(),
}));
vi.mock("../../supabase", () => ({ createServerSupabase: () => ({}) }));

import { closeRedisConnection, getRedisProducerConnection } from "../connection";
import { closeExtractionQueue, getExtractionQueue } from "../extractionQueue";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { sweepStaleGeneratingCells } from "../../../modules/tabular/tabular.maintenance";
import { makeFakeDb } from "../../../modules/tabular/__tests__/fakeDb";

afterAll(async () => {
    await Promise.race([
        Promise.all([closeExtractionQueue(), closeRedisConnection()]).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    vi.restoreAllMocks();
});

const reportsOfKind = (kind: string) =>
    mocks.reportError.mock.calls.filter(
        ([error]) => diagnosticErrorTags(error).error_kind === kind,
    );

it("files one outage warning for a real producer Queue, and a sweep during the outage prints no raw Redis error and leaves its cells alone", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const queue = getExtractionQueue();
    // Count failed reconnects on the client, not the Queue: a test listener
    // on the Queue would itself suppress BullMQ's console.error fallback.
    const failedAttempts: Error[] = [];
    getRedisProducerConnection().on("error", (error) => failedAttempts.push(error));

    // Two cells mid-generation on a review whose lease has lapsed: only the
    // job lookup decides whether they are flipped, and it cannot answer.
    const fake = makeFakeDb({
        tables: {
            tabular_cells: {
                data: [
                    { id: "c1", review_id: "r1", row_id: "w1", column_index: 0, generation_id: "g1" },
                    { id: "c2", review_id: "r1", row_id: "w2", column_index: 0, generation_id: "g1" },
                ],
                error: null,
            },
            tabular_reviews: {
                data: [{ id: "r1", active_generation_id: null, generation_lease_expires_at: null }],
                error: null,
            },
        },
    });
    await expect(sweepStaleGeneratingCells(fake.db)).resolves.toBe(0);
    expect(fake.calls.filter((call) => call.op === "update")).toHaveLength(0);

    // Several failed reconnects reached the Queue.
    await vi.waitFor(() => expect(failedAttempts.length).toBeGreaterThanOrEqual(2), {
        timeout: 8_000,
    });

    // The only console.error is the sweep's own line, which carries the error
    // it already reported. No raw Redis error reached the console bridge.
    for (const args of consoleError.mock.calls) {
        expect(String(args[0])).toMatch(/^\[stale-sweep\]/);
    }
    const rawRedis = consoleError.mock.calls.filter((args) =>
        args.some((arg) => arg instanceof Error && /ECONNREFUSED/.test(arg.message)),
    );
    expect(rawRedis).toHaveLength(0);

    const outage = reportsOfKind("queue.connection_lost");
    expect(outage).toHaveLength(1);
    expect(diagnosticErrorTags(outage[0][0]).failure_code).toBe("ECONNREFUSED");
    expect(outage[0][1]).toEqual({
        level: "warning",
        tags: { component: "queue", stage: "connection", queue: "tabular-extraction" },
    });
    expect(reportsOfKind("queue.producer_error")).toHaveLength(0);

    // A producer defect (not a lost connection) is an error-level report.
    queue.emit("error", new Error("Unexpected reply from Redis"));
    const defects = reportsOfKind("queue.producer_error");
    expect(defects).toHaveLength(1);
    expect(defects[0][1]).toEqual({
        level: "error",
        tags: { component: "queue", stage: "producer", queue: "tabular-extraction" },
    });
    expect(reportsOfKind("queue.connection_lost")).toHaveLength(1);

    // The producer connection coming back closes the outage even in a
    // process with no Worker (so no consumer connection).
    getRedisProducerConnection().emit("ready");
    expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/^\[queue\] redis recovered after \d+ consecutive failure\(s\)$/),
    );
});
