import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { RedisQueueBackend } from "bullmq";

const mocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../../observability/sentry", async load => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));
import { queueConnectionRecovered, watchQueueErrors } from "../consumerErrors";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";

afterEach(() => {
    mocks.reportError.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});
const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const escalations = () => mocks.reportError.mock.calls.filter(([error]) =>
    diagnosticErrorTags(error).error_kind === "queue.redis_outage_persisting");

it("tracks actual blocking-connection recovery without accepting unrelated readiness", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const shared = new EventEmitter();
    const blocking = new EventEmitter();
    // Exercise BullMQ's real forwarding order, not a manually reset outage gate.
    const backend = new RedisQueueBackend(shared as never, "recovery", {} as never,
        key => key, {} as never, blocking as never);
    const worker = Object.assign(new EventEmitter(), { getBackend: () => backend });
    backend.on("error", error => worker.emit("error", error));
    watchQueueErrors(worker, "worker");

    blocking.emit("error", reset());
    now = 16 * 60_000;
    shared.emit("ready"); // A different connection's INFO cannot prove recovery.
    blocking.emit("error", reset());
    expect(escalations()).toHaveLength(1);

    blocking.emit("ready"); // This connection's INFO has now succeeded.
    now += 20 * 60_000;
    blocking.emit("error", reset());
    expect(escalations()).toHaveLength(1); // New incident, not a 36-minute outage.
    now += 16 * 60_000;
    blocking.emit("error", reset());
    expect(escalations()).toHaveLength(2);
    blocking.emit("ready");

    // Replacing a dead producer/worker retires its old RedisConnection. It
    // cannot emit ready again and must not age a replacement's first failure.
    blocking.emit("error", reset());
    Object.assign(blocking, { status: "closed" });
    now += 20 * 60_000;
    shared.emit("error", reset());
    expect(escalations()).toHaveLength(2);
    shared.emit("ready");
});

it("uses successful worker reads to recover errors originating in the run loop", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const worker = new EventEmitter();
    watchQueueErrors(worker, "worker");
    worker.emit("error", reset());
    worker.emit("drained");
    now = 20 * 60_000;
    worker.emit("error", reset());
    expect(escalations()).toHaveLength(0);
    worker.emit("active");
});

it("escalates TCP accept/reset flapping until a Redis command actually succeeds", async () => {
    let now = 0;
    let accepts = 0;
    let healthy = false;
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        accepts++;
        let pending = "";
        socket.on("data", chunk => {
            if (!healthy) {
                socket.resetAndDestroy();
                return;
            }
            pending += chunk.toString();
            // Minimal RESP server: answer the real ioredis handshake and QUIT.
            for (;;) {
                const end = pending.indexOf("\r\n");
                if (end < 0) return;
                const count = Number(pending.slice(1, end));
                let cursor = end + 2;
                const args: string[] = [];
                for (let n = 0; n < count; n++) {
                    const headerEnd = pending.indexOf("\r\n", cursor);
                    if (headerEnd < 0) return;
                    const size = Number(pending.slice(cursor + 1, headerEnd));
                    const start = headerEnd + 2;
                    if (pending.length < start + size + 2) return;
                    args.push(pending.slice(start, start + size));
                    cursor = start + size + 2;
                }
                pending = pending.slice(cursor);
                if (args[0]?.toLowerCase() === "info") {
                    const info = "redis_version:7.2.0\r\nloading:0\r\n";
                    socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
                } else socket.write("+OK\r\n");
                if (!pending) return;
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${address.port}`);
    // connection.ts is not imported above, so its URL reads this test's port.
    const { getRedisConnection, closeRedisConnection } = await import("../connection.js");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = getRedisConnection();
    const ready = vi.fn();
    client.on("ready", ready);
    try {
        expect(client.options.enableReadyCheck).toBe(true);
        await vi.waitFor(() => expect(accepts).toBeGreaterThanOrEqual(2));
        expect(ready).not.toHaveBeenCalled();
        now = 16 * 60_000;
        await vi.waitFor(() => expect(escalations()).toHaveLength(1));
        healthy = true;
        await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
        now += 20 * 60_000;
        client.emit("error", reset());
        expect(escalations()).toHaveLength(1); // Successful INFO ended the old outage.
        queueConnectionRecovered(client);
    } finally {
        client.disconnect();
        await closeRedisConnection();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
