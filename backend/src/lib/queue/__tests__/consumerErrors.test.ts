import { afterAll, expect, it, vi } from "vitest";

// MIK-91: the BullMQ consumer connection had no 'error' listener, so every
// reconnect attempt against a down Redis printed "[ioredis] Unhandled error
// event" and the Sentry console bridge filed it as an untyped "Failure in
// application" (MIKE-BACKEND-47, -3M, -4B, ...). Nothing listens on this port.
const mocks = vi.hoisted(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    return { reportError: vi.fn() };
});
vi.mock("../../observability/sentry", async (load) => ({
    ...(await load<typeof import("../../observability/sentry")>()),
    reportError: mocks.reportError,
}));

import { closeRedisConnection, getRedisConnection } from "../connection";
import { AppError } from "../../appError";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";

afterAll(async () => {
    await closeRedisConnection().catch(() => {});
    vi.restoreAllMocks();
});

it("reports a down Redis once, as a typed warning, across repeated reconnect errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors: unknown[] = [];
    const connection = getRedisConnection();
    // Count the real reconnect failures without adding an 'error' listener
    // (which would hide the bug). ioredis routes every error through
    // silentEmit, which emits to listeners or else console.errors it.
    // silentEmit is private ioredis API (Redis.prototype.silentEmit in
    // ioredis 6.x, backend/package.json ^6.0.0); if a major bump removes it,
    // this patch throws here rather than passing silently.
    const internal = connection as unknown as {
        silentEmit(event: string, arg: unknown): unknown;
    };
    const silentEmit = internal.silentEmit.bind(connection);
    internal.silentEmit = (event, arg) => {
        if (event === "error") errors.push(arg);
        return silentEmit(event, arg);
    };
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2), {
        timeout: 5_000,
    });

    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = mocks.reportError.mock.calls[0];
    expect(reported).toBeInstanceOf(AppError);
    expect(diagnosticErrorTags(reported)).toMatchObject({
        error_kind: "queue.connection_lost",
        failure_code: "ECONNREFUSED",
    });
    expect(context).toEqual({
        level: "warning",
        tags: { component: "queue", stage: "connection" },
    });
    expect(consoleError).not.toHaveBeenCalled();
});
