// How the DB-queue runner reports to Sentry: one report per failure class
// for a claim that fails every tick, the PostgREST code on the reported
// error, and console lines the console bridge can recognise as already
// reported (MIKE-BACKEND-P, -3, -G).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("../../supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));
vi.mock("../../observability/sentry", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../observability/sentry")>();
    // Pass through: the real reportError marks the object as reported,
    // which is what the console-bridge dedupe below depends on.
    mocks.reportError.mockImplementation(actual.reportError);
    return { ...actual, reportError: mocks.reportError };
});

import { scrubEvent } from "../../observability/sentry";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { createDbJobClaimGate, processClaimedJob, runDbJobTick } from "../runner";
import { DbJobDeferredError, type DbJob } from "../types";

const MISSING_RPC = {
    code: "PGRST202",
    message:
        "Could not find the function public.claim_db_jobs(p_limit, p_stale_seconds) in the schema cache",
    details: null,
    hint: null,
};

function makeDb(rpc: () => Promise<{ data: unknown; error: unknown }>) {
    const builder: Record<string, unknown> = {};
    for (const method of ["update", "delete", "select", "eq", "neq", "lt", "limit"]) {
        builder[method] = () => builder;
    }
    builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve);
    return { from: () => builder, rpc };
}

const JOB = (over: Partial<DbJob> = {}): DbJob => ({
    id: "job-1",
    kind: "test.kind",
    payload: {},
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "2026-08-21T00:00:00Z",
    claimed_at: "2026-08-21T00:00:01Z",
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "2026-08-21T00:00:00Z",
    ...over,
});

/** What the console bridge would hand scrubEvent for a console.error call. */
function bridged(args: unknown[]) {
    return scrubEvent(
        { logger: "console", message: String(args[0]) } as Parameters<
            typeof scrubEvent
        >[0],
        { captureContext: { extra: { arguments: args } } },
    );
}

function claimReports() {
    return mocks.reportError.mock.calls.filter(
        ([, context]) =>
            (context as { tags?: { stage?: string } } | undefined)?.tags?.stage ===
            "claim",
    );
}

type ConsoleSpy = ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let consoleError: ConsoleSpy;
let consoleWarn: ConsoleSpy;
let consoleLog: ConsoleSpy;

beforeEach(() => {
    mocks.reportError.mockClear();
    consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {}) as unknown as ConsoleSpy;
    consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {}) as unknown as ConsoleSpy;
    consoleLog = vi
        .spyOn(console, "log")
        .mockImplementation(() => {}) as unknown as ConsoleSpy;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("runDbJobTick claim failure reporting", () => {
    it("reports the PostgREST code (PGRST202) instead of a code-less re-wrapped message", async () => {
        const db = makeDb(async () => ({ data: null, error: MISSING_RPC }));
        await runDbJobTick(db as never, {}, {}, createDbJobClaimGate());

        expect(claimReports()).toHaveLength(1);
        const reported = claimReports()[0][0];
        expect(reported).toBeInstanceOf(Error);
        expect(diagnosticErrorTags(reported).failure_code).toBe("PGRST202");
        // The dependency's free text never becomes the error's own message.
        expect((reported as Error).message).not.toContain("claim_db_jobs");
    });

    it("logs the reported Error object, so the console bridge drops its copy", async () => {
        const db = makeDb(async () => ({ data: null, error: MISSING_RPC }));
        await runDbJobTick(db as never, {}, {}, createDbJobClaimGate());

        const logged = consoleError.mock.calls.find(
            ([label]) => label === "[dbq] claim failed",
        );
        expect(logged).toBeDefined();
        expect(bridged(logged!)).toBeNull();
    });

    it("reports a claim that fails every tick once, then stays quiet and backs off", async () => {
        vi.useFakeTimers();
        const gate = createDbJobClaimGate();
        const db = makeDb(async () => ({ data: null, error: MISSING_RPC }));

        let ticks = 0;
        // Drive the loop the way startDbJobRunner does: an interval that
        // skips while the gate says to wait. 10 minutes at the 5 s cadence.
        for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 5_000) {
            if (gate.ready()) {
                ticks += 1;
                await runDbJobTick(db as never, {}, {}, gate);
            }
            await vi.advanceTimersByTimeAsync(5_000);
        }

        expect(claimReports()).toHaveLength(1);
        expect(consoleError.mock.calls.filter(([l]) => l === "[dbq] claim failed")).toHaveLength(1);
        // Backed off to the 60 s ceiling instead of 120 claims in 10 minutes.
        expect(ticks).toBeLessThan(20);
        // A compact count line, at most once a minute.
        const lines = consoleWarn.mock.calls.filter(([m]) =>
            String(m).startsWith("[dbq] claim still failing (Error:PGRST202)"),
        );
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.length).toBeLessThanOrEqual(10);
    });

    it("reports again when the failure class changes, and after a recovery", async () => {
        const gate = createDbJobClaimGate();
        let error: unknown = MISSING_RPC;
        const db = makeDb(async () => ({ data: error ? null : [], error }));

        await runDbJobTick(db as never, {}, {}, gate);
        await runDbJobTick(db as never, {}, {}, gate);
        expect(claimReports()).toHaveLength(1);

        error = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
        await runDbJobTick(db as never, {}, {}, gate);
        expect(claimReports()).toHaveLength(2);

        error = null;
        await runDbJobTick(db as never, {}, {}, gate);
        expect(consoleLog).toHaveBeenCalledWith(
            expect.stringContaining("[dbq] claim recovered after 3 consecutive failure(s)"),
        );

        error = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
        await runDbJobTick(db as never, {}, {}, gate);
        expect(claimReports()).toHaveLength(3);
    });
});

describe("processClaimedJob console lines", () => {
    it("logs a failed job with the reported Error, so the bridge files no duplicate (MIKE-BACKEND-G)", async () => {
        const db = makeDb(async () => ({ data: [], error: null }));
        await processClaimedJob(db as never, {
            "test.kind": async () => {
                throw new Error("Memory curator scope failed");
            },
        }, JOB());

        expect(mocks.reportError).toHaveBeenCalledTimes(1);
        const logged = consoleError.mock.calls.find(
            ([label]) => label === "[dbq] job failed; will retry",
        );
        expect(logged).toBeDefined();
        expect(bridged(logged!)).toBeNull();
    });

    it("gives a job rejected with a PostgREST object a code-carrying Error", async () => {
        const db = makeDb(async () => ({ data: [], error: null }));
        await processClaimedJob(db as never, {
            "test.kind": async () => {
                throw { code: "42P01", message: 'relation "x" does not exist' };
            },
        }, JOB());

        const reported = mocks.reportError.mock.calls[0][0];
        expect(reported).toBeInstanceOf(Error);
        expect(diagnosticErrorTags(reported).failure_code).toBe("42P01");
        const logged = consoleError.mock.calls.find(
            ([label]) => label === "[dbq] job failed; will retry",
        );
        expect(bridged(logged!)).toBeNull();
    });

    it("logs an unknown kind with the reported Error", async () => {
        const db = makeDb(async () => ({ data: [], error: null }));
        await processClaimedJob(db as never, {}, JOB({ kind: "nope.kind" }));

        const logged = consoleError.mock.calls.find(
            ([label]) => label === "[dbq] unknown job kind",
        );
        expect(bridged(logged!)).toBeNull();
    });

    it("never logs a deferral at error level (the console bridge would file it)", async () => {
        const db = makeDb(async () => ({ data: [], error: null }));
        await processClaimedJob(db as never, {
            "test.kind": async () => {
                throw new DbJobDeferredError(
                    new Date(Date.now() + 60_000).toISOString(),
                    "memory_quiet_period",
                );
            },
        }, JOB());

        expect(mocks.reportError).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(
            "[dbq] job deferred",
            expect.objectContaining({ id: "job-1" }),
        );
    });
});
