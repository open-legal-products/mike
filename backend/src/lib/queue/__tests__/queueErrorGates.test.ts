import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../../observability/sentry", async (load) => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));

import {
    createWorkerErrorGate,
    isQueueConnectionError,
    queueConnectionRecovered,
    queueErrorClass,
    watchQueueErrors,
} from "../consumerErrors";

const errno = (code: string) =>
    Object.assign(new Error(`connect ${code} 127.0.0.1:6379`), { code });

describe("isQueueConnectionError", () => {
    it("treats errno codes and BullMQ's closed-connection error as an outage", () => {
        expect(isQueueConnectionError(errno("ECONNREFUSED"))).toBe(true);
        expect(isQueueConnectionError(errno("ETIMEDOUT"))).toBe(true);
        expect(isQueueConnectionError(errno("ENOTFOUND"))).toBe(true);
        expect(isQueueConnectionError(new Error("Connection is closed."))).toBe(true);
    });

    it("treats BullMQ's lock and run-loop errors as defects", () => {
        expect(isQueueConnectionError(new Error("could not renew lock for job 7"))).toBe(false);
        expect(
            isQueueConnectionError(Object.assign(new Error("Missing lock for job 7. moveToFinished"), { code: -2 })),
        ).toBe(false);
        expect(isQueueConnectionError("not an error")).toBe(false);
        expect(isQueueConnectionError(errno("EINVAL"))).toBe(false);
        expect(isQueueConnectionError(errno("EACCES"))).toBe(false);
    });
});

describe("queueErrorClass", () => {
    it("ignores the job id in BullMQ's messages", () => {
        expect(queueErrorClass(new Error("could not renew lock for job 1"))).toBe(
            queueErrorClass(new Error("could not renew lock for job 9f2c-77")),
        );
        expect(queueErrorClass(new Error("Missing lock for job 1. moveToFinished"))).toBe(
            queueErrorClass(new Error("Missing lock for job 2. moveToFinished")),
        );
        expect(queueErrorClass(new Error("could not renew lock for job 1"))).not.toBe(
            queueErrorClass(new Error("Missing lock for job 1. moveToFinished")),
        );
    });
});

describe("createWorkerErrorGate", () => {
    it("keeps independent windows when defect classes alternate", () => {
        let now = 0;
        const gate = createWorkerErrorGate({ windowMs: 1000, now: () => now,
            log: { warn: vi.fn(), log: vi.fn() } });
        const a = new Error("could not renew lock for job 1");
        const b = new Error("Missing lock for job 2. moveToFinished");
        expect(gate.failure(a).report).toBe(true);
        now = 100;
        expect(gate.failure(b).report).toBe(true);
        now = 999;
        expect(gate.failure(a).report).toBe(false);
        now = 1000;
        expect(gate.failure(a).report).toBe(true);
        expect(gate.failure(b).report).toBe(false);
        now = 1100;
        expect(gate.failure(b).report).toBe(true);
    });

    it("re-reports a recurring class once its window has passed", () => {
        const clock = { t: 0 };
        const log = { warn: vi.fn(), log: vi.fn() };
        const gate = createWorkerErrorGate({ windowMs: 15 * 60_000, now: () => clock.t, log });
        const defect = () => new Error("stalled checker failed");
        let reports = 0;
        // Every 30 s for 24 h, with nothing else happening in between.
        for (clock.t = 0; clock.t < 24 * 3_600_000; clock.t += 30_000) {
            if (gate.failure(defect()).report) reports += 1;
        }
        expect(reports).toBe(96);
        expect(log.warn).toHaveBeenCalled();
    });
});

describe("watchQueueErrors", () => {
    it("counts a forwarded connection error once and keeps Worker defects out of the outage count", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const connection = new EventEmitter();
        const workerA = new EventEmitter();
        const workerB = new EventEmitter();
        watchQueueErrors(connection, "connection");
        watchQueueErrors(workerA, "worker");
        watchQueueErrors(workerB, "worker");

        for (let attempt = 0; attempt < 3; attempt++) {
            // BullMQ forwards the same Error object to every Worker.
            const error = errno("ECONNREFUSED");
            connection.emit("error", error);
            workerA.emit("error", error);
            workerB.emit("error", error);
        }
        workerA.emit("error", new Error("could not renew lock for job 1"));
        queueConnectionRecovered(connection);

        expect(log).toHaveBeenCalledWith(
            "[queue] redis recovered after 3 consecutive failure(s)",
        );
        expect(mocks.reportError).toHaveBeenCalledTimes(2);
        vi.restoreAllMocks();
    });
});
