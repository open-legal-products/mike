import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// A Redis outage is filed once, as a warning, so the org's level:error
// alert does not fire for it. An outage that is still failing 15 minutes
// later (no 'ready' in between) must file ONE error-level event so a
// self-hosted install with stalled uploads pages someone, and nothing more
// until the connection recovers.

const mocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../../observability/sentry", async (load) => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));

import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { queueConnectionRecovered, watchQueueErrors } from "../consumerErrors";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const refused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" });

it("escalates a Redis outage still failing after 15 minutes to one error, once per outage", () => {
    vi.useFakeTimers({ now: new Date("2026-11-06T00:00:00Z") });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const connection = new EventEmitter();
    watchQueueErrors(connection, "connection");
    const levels = () => mocks.reportError.mock.calls.map(([, context]) => context.level);
    // ioredis retries every couple of seconds; one error every 30 s is enough.
    const failFor = (ms: number) => {
        for (let t = 0; t < ms; t += 30_000) {
            connection.emit("error", refused());
            vi.advanceTimersByTime(30_000);
        }
    };

    failFor(14 * 60_000);
    expect(levels()).toEqual(["warning"]);

    failFor(60_000);
    connection.emit("error", refused());
    expect(levels()).toEqual(["warning", "error"]);
    const [escalated, context] = mocks.reportError.mock.calls[1];
    expect(diagnosticErrorTags(escalated)).toMatchObject({
        error_kind: "queue.redis_outage_persisting",
        failure_code: "ECONNREFUSED",
    });
    expect(context.tags).toEqual({ component: "queue", stage: "connection", outage_minutes: 15 });

    failFor(45 * 60_000);
    expect(levels()).toEqual(["warning", "error"]);

    // After recovery, a new outage starts its own 15-minute clock.
    queueConnectionRecovered(connection);
    mocks.reportError.mockClear();
    failFor(14 * 60_000);
    expect(levels().filter((level) => level === "error")).toEqual([]);
    failFor(2 * 60_000);
    expect(levels().filter((level) => level === "error")).toEqual(["error"]);
});
