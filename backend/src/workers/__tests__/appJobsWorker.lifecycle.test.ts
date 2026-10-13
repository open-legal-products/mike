import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ callbacks: [] as ((job: {data: {dbJobId: string}}) => Promise<void>)[],
    policies: {} as Record<string, {heartbeatIntervalMs: number; maxDurationMs: number}>, rpc: vi.fn(), process: vi.fn(), report: vi.fn(), pause: vi.fn(async () => {}), close: vi.fn(async () => {}) }));
vi.mock("bullmq", () => ({ Worker: class {
    constructor(_queue: unknown, callback: (job: {data: {dbJobId: string}}) => Promise<void>) { state.callbacks.push(callback); }
    on() {} pause = state.pause; close = state.close;
} }));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => ({ rpc: state.rpc }) }));
vi.mock("../../lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../../lib/dbq/runner", () => ({ processClaimedJob: state.process, STALE_SECONDS: 600 }));
vi.mock("../../jobs/registry", () => ({ DB_JOB_HANDLERS: {}, DB_JOB_FAILURE_HOOKS: {}, DB_JOB_EXECUTION_POLICIES: state.policies }));
vi.mock("../../lib/observability/sentry", () => ({ reportError: state.report }));
import { createAppJobsWorker, runAppJobDelivery, stopAppJobIntake, stopAppJobsWorker } from "../appJobsWorker";
afterEach(async () => { await stopAppJobsWorker(); Object.keys(state.policies).forEach((key) => delete state.policies[key]); vi.clearAllMocks(); state.callbacks.length = 0; });
describe("Redis claim intake lifecycle", () => {
    it.each([
        ["fixture", { heartbeatIntervalMs: 0, maxDurationMs: 1000 }],
        ["fixture", { heartbeatIntervalMs: 100, maxDurationMs: Infinity }],
        ["storage.cleanup", { heartbeatIntervalMs: 100, maxDurationMs: 1000 }],
        ["document.cleanup", { heartbeatIntervalMs: 100, maxDurationMs: 1000 }],
    ] as const)("rejects invalid %s policy before creating a consumer", (kind, policy) => {
        state.policies[kind] = policy;
        expect(() => createAppJobsWorker()).toThrow();
        expect(state.callbacks).toHaveLength(0);
        expect(state.rpc).not.toHaveBeenCalled();
        delete state.policies[kind];
        createAppJobsWorker();
        expect(state.callbacks).toHaveLength(1);
    });
    it("suppresses new claims after stop and old callbacks after restart", async () => {
        createAppJobsWorker();
        const oldCallback = state.callbacks[0];
        stopAppJobIntake();
        expect(state.pause).toHaveBeenCalledWith(true);
        await oldCallback({ data: { dbJobId: "old" } });
        expect(state.rpc).not.toHaveBeenCalled();
        await stopAppJobsWorker();
        createAppJobsWorker();
        await oldCallback({ data: { dbJobId: "old" } });
        expect(state.rpc).not.toHaveBeenCalled();
        state.rpc.mockResolvedValueOnce({ data: [], error: null });
        await state.callbacks[1]({ data: { dbJobId: "new" } });
        expect(state.rpc).toHaveBeenCalledTimes(1);
    });
    it("never dispatches a claim returned after shutdown", async () => {
        let release!: (value: unknown) => void;
        state.rpc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const controller = new AbortController();
        const delivery = runAppJobDelivery({ dbJobId: "late" }, undefined, controller.signal);
        controller.abort();
        release({ data: [{ id: "late", kind: "fixture" }], error: null });
        await delivery;
        expect(state.process).not.toHaveBeenCalled();
    });
    it("does not report pause error secrets, paths or original stack", async () => {
        const failure = new Error("fixture-secret-token /private/customer/file.txt");
        state.pause.mockRejectedValueOnce(failure);
        createAppJobsWorker();
        stopAppJobIntake();
        await stopAppJobsWorker();
        expect(state.report).toHaveBeenCalledTimes(1);
        const reported = state.report.mock.calls[0][0] as Error;
        expect(reported).not.toBe(failure);
        expect(reported.cause).toBeUndefined();
        expect(reported.message).toMatch(/^app_job_pause_/);
        expect(reported.stack).not.toContain("fixture-secret-token");
        expect(reported.stack).not.toContain("customer/file.txt");
    });

});
